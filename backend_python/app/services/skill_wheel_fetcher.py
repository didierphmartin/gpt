"""Port of Services/SkillWheelFetcher.php (with SkillWheelError).

Gathers native (CPython 3.12) wheels for a skill's declared libraries with `pip download`, one run per platform
group, so the exported package can install offline. Libraries with no binary wheel are built from source only when
the result is pure Python.
"""
from __future__ import annotations

import glob
import os
import re
import secrets
import shutil
import subprocess
import tempfile
from typing import Callable


class SkillWheelError(RuntimeError):
    """A wheel-gathering failure with the HTTP status and extra fields the route should answer with."""

    def __init__(self, message: str, status: int, data: dict | None = None):
        super().__init__(message)
        self._status = status
        self._data = data or {}

    def statusCode(self) -> int:
        return self._status

    def data(self) -> dict:
        return self._data


_NO_WHEEL = re.compile(r'No matching distribution|Could not find a version', re.I)
_PURE = re.compile(r'-(py3|py2\.py3)-none-any\.whl$')


class SkillWheelFetcher:
    PLATFORMS = [
        ['manylinux_2_17_x86_64', 'manylinux2014_x86_64'],
        ['manylinux_2_17_aarch64', 'manylinux2014_aarch64'],
        ['macosx_11_0_arm64'],
    ]

    def __init__(self, runner: Callable[[list], dict] | None = None, python: str = 'python3'):
        """runner(argv) -> {code, out}."""
        self.runner = runner or self._subprocessRunner
        self.python = python
        self.tmp = ''
        self.built: dict = {}   # dep => folder with its built pure wheel (None = not pure)

    def fetch(self, deps: list) -> dict:
        """deps: pip requirement strings. Returns wheel filename => bytes."""
        deps = [d for d in (str(x).strip(' \t\n\r\0\x0b') for x in deps) if d != '']
        for d in deps:
            if d.startswith('-'):
                raise SkillWheelError('Invalid library name: ' + d, 400)
        if not deps:
            return {}
        if self._run([self.python, '-m', 'pip', '--version', '--no-cache-dir'])['code'] != 0:
            raise SkillWheelError('Exporting a skill with libraries needs Python 3 on the server.', 503)
        tmp = tempfile.gettempdir() + '/skillwheels_' + secrets.token_hex(8)
        os.mkdir(tmp, 0o700)
        self.tmp = tmp
        self.built = {}
        try:
            wheels: dict = {}
            for i, group in enumerate(self.PLATFORMS):
                dest = f'{tmp}/p{i}'
                os.mkdir(dest)
                self._gather(deps, group, dest)
                for f in sorted(glob.glob(f'{dest}/*.whl')):
                    if os.path.basename(f) not in wheels:
                        with open(f, 'rb') as fh:
                            wheels[os.path.basename(f)] = fh.read()
            return wheels
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def _gather(self, deps: list, group: list, dest: str) -> None:
        r = self._download(deps, group, dest)
        if r['code'] == 0:
            return
        self._assertNoWheel(r)
        # Find which dependency has no binary wheel on this platform, and try it as pure Python.
        for dep in deps:
            r = self._download([dep], group, dest)
            if r['code'] == 0:
                continue
            self._assertNoWheel(r)
            built = self._buildPure(dep)
            if built is None:
                raise SkillWheelError(f'No compatible wheel for {dep} on {group[0]}.', 422, {'library': dep, 'platform': group[0]})
            # pip resolves the built wheel plus its own requirements from the index.
            r = self._download([dep], group, dest, built)
            if r['code'] != 0:
                self._assertNoWheel(r)
                raise SkillWheelError(f'No compatible wheel for a requirement of {dep} on {group[0]}.', 422,
                                      {'library': dep, 'platform': group[0]})

    def _buildPure(self, dep: str) -> str | None:
        """Builds dep from source once per fetch; returns the folder holding its pure-Python wheel, or None."""
        if dep in self.built:
            return self.built[dep]
        d = f'{self.tmp}/built{len(self.built)}'
        os.mkdir(d)
        r = self._run([self.python, '-m', 'pip', 'wheel', '--no-cache-dir', '--no-deps', '--wheel-dir', d, dep])
        files = glob.glob(f'{d}/*.whl') if r['code'] == 0 else []
        pure = bool(files) and all(_PURE.search(f) for f in files)
        self.built[dep] = d if pure else None
        return self.built[dep]

    @staticmethod
    def _assertNoWheel(r: dict) -> None:
        """Only "no wheel" answers may fall back or become a 422; anything else (network, index, bad requirement) is a 502."""
        if not _NO_WHEEL.search(r['out']):
            raise SkillWheelError('Could not download the libraries: ' + r['out'].strip(' \t\n\r\0\x0b')[-300:], 502)

    def _download(self, deps: list, group: list, dest: str, findLinks: str | None = None) -> dict:
        argv = [self.python, '-m', 'pip', 'download', '--no-cache-dir', '--only-binary=:all:', '--python-version', '3.12',
                '--implementation', 'cp', '--abi', 'cp312', '--abi', 'abi3', '--abi', 'none']
        for platform in group:
            argv += ['--platform', platform]
        if findLinks is not None:
            argv += ['--find-links', findLinks]
        argv += ['--dest', dest]
        return self._run(argv + deps)

    def _run(self, argv: list) -> dict:
        try:
            return self.runner(argv)
        except Exception:  # noqa: BLE001 -- PHP catch (\Throwable)
            return {'code': 127, 'out': ''}

    @staticmethod
    def _subprocessRunner(argv: list) -> dict:
        try:
            p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
        except subprocess.TimeoutExpired as e:
            out = (e.stdout or b'').decode('utf-8', errors='replace')
            return {'code': 124, 'out': out + '\ntimed out'}
        except OSError:
            return {'code': 127, 'out': ''}
        return {'code': p.returncode, 'out': p.stdout.decode('utf-8', errors='replace')}
