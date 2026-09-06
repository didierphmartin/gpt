"""Entry point — the Python twin of backend/index.php, plus the streaming bridge (spec §3)."""
from __future__ import annotations

import asyncio
import os
import tempfile
import traceback
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from starlette.responses import Response, StreamingResponse

from app.config import load_config
from app.db import open_primary
from app.middleware.processor import MiddlewareProcessor
from app.routes import CONTROLLERS, ROUTES
from app.support.http import build_ctx, json_response, render
from app.support.logger import error_log, get_logger
from app.support.phpcompat import is_numeric, php_intval
from app.support.router import Dispatcher
from app.support.sse import SseStream

METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']
SSE_HEADERS = {'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'}


def create_app(config: dict | None = None, *, controllers: dict | None = None, routes: list | None = None) -> FastAPI:
    config = config or load_config()
    get_logger()
    registry = controllers if controllers is not None else CONTROLLERS
    dispatcher = Dispatcher(routes if routes is not None else ROUTES)
    processor = MiddlewareProcessor(config, lambda: open_primary(config))
    executor = ThreadPoolExecutor(max_workers=int(config.get('py_workers', 100)), thread_name_prefix='req')

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        executor.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.executor = executor

    def handle_sync(request: Request, raw_body: bytes, sse: SseStream, files: dict, form_fields: dict) -> Response | None:
        ctx = build_ctx(request, raw_body)
        ctx['sse'] = sse
        ctx['files'] = files
        if form_fields:
            ctx['body'] = dict(form_fields)
        cors_headers = processor.cors.headers(request.headers.get('origin', ''))

        def with_cors(resp):
            if resp is not None:
                for k, v in cors_headers.items():
                    resp.headers[k] = v
            return resp

        try:
            mw = processor.process(ctx)
        except Exception as e:  # noqa: BLE001
            error_log(f'[Backend] Middleware error: {e}\n{traceback.format_exc()}')
            return with_cors(json_response(500, {'success': False, 'error': str(e)}))
        if mw['handled']:
            r = mw['response']
            body = r.get('body')
            if body:
                return with_cors(json_response(r.get('status_code', 200), body, r.get('headers') or {}))
            return with_cors(Response(status_code=r.get('status_code', 200), headers=r.get('headers') or {}))
        ctx = mw['request']

        try:
            db = open_primary(config)
        except Exception as e:  # noqa: BLE001
            error_log(f'[Backend] Database connection failed: {e}')
            return with_cors(json_response(500, {'success': False, 'error': 'Database connection failed'}))

        try:
            route = dispatcher.dispatch(ctx['method'], ctx['uri'])
            if route.status == 'NOT_FOUND':
                return with_cors(json_response(404, {'success': False, 'error': 'Endpoint not found', 'uri': ctx['uri']}))
            if route.status == 'METHOD_NOT_ALLOWED':
                return with_cors(json_response(405, {'success': False, 'error': 'Method not allowed', 'allowed_methods': route.allowed}))
            controller_name, method_name = route.handler
            cls = registry.get(controller_name)
            if cls is None:
                return with_cors(json_response(500, {'success': False, 'error': f'Controller not found: {controller_name}'}))
            try:
                controller = cls(db, config)
                fn = getattr(controller, method_name, None)
                if fn is None:
                    return with_cors(json_response(500, {'success': False, 'error': f'Method not found: {method_name}'}))
                if route.params:
                    params = [php_intval(v) if is_numeric(v) else v for v in route.params.values()]
                    ctx['params'] = dict(route.params)
                    result = fn(ctx, *params)
                else:
                    result = fn(ctx)
                if sse.started:
                    return None                     # streaming path: response already produced
                resp = render(result)
                return with_cors(resp if resp is not None else Response(status_code=200))
            except Exception as e:  # noqa: BLE001
                error_log(f'[Backend] Controller error: {e}\n{traceback.format_exc()}')
                if sse.started:
                    return None
                return with_cors(json_response(500, {'success': False, 'error': str(e)}))
        finally:
            if sse.started and not sse.ended:
                sse.end()
            db.close()

    @app.api_route('/{path:path}', methods=METHODS, include_in_schema=False)
    @app.api_route('/', methods=METHODS, include_in_schema=False)
    async def catch_all(request: Request):
        loop = asyncio.get_running_loop()
        sse = SseStream(loop)
        files: dict = {}
        form_fields: dict = {}
        tmp_paths: list[str] = []
        raw = b''
        ctype = request.headers.get('content-type', '')
        if ctype.startswith('multipart/form-data'):
            form = await request.form()
            for key, value in form.multi_items():
                if hasattr(value, 'filename'):
                    data = await value.read()
                    tmp = tempfile.NamedTemporaryFile(delete=False, prefix='php_upload_')
                    tmp.write(data); tmp.close()
                    tmp_paths.append(tmp.name)
                    files[key] = {'name': value.filename or '', 'type': value.content_type or '',
                                  'tmp_name': tmp.name, 'size': len(data), 'error': 0}
                else:
                    form_fields[key] = value
        else:
            raw = await request.body()

        work = loop.run_in_executor(executor, handle_sync, request, raw, sse, files, form_fields)

        def _cleanup(_):
            for p in tmp_paths:
                try:
                    os.unlink(p)
                except OSError:
                    pass
            if not work.cancelled() and work.exception():
                error_log(f'[Backend] request thread error: {work.exception()}')
        work.add_done_callback(_cleanup)

        done, _ = await asyncio.wait({work, sse.started_future}, return_when=asyncio.FIRST_COMPLETED)
        if work in done and not sse.started:
            return work.result()

        cors_headers = processor.cors.headers(request.headers.get('origin', ''))

        async def gen():
            try:
                while True:
                    frame = await sse.queue.get()
                    if frame is None:
                        return
                    yield frame
            finally:
                # Runs on a clean sentinel exit (harmless — the controller is past its
                # last send) and on asyncio.CancelledError. It also runs on GeneratorExit:
                # on spec_version >= 2.4, Starlette's StreamingResponse.stream_response()
                # has no try/finally around `async for chunk in body_iterator`, so a
                # disconnect surfaced as an OSError from send() (or a cancellation that
                # lands inside send() rather than inside this generator's own await)
                # simply abandons this generator mid-yield; only reclaimed later when
                # asyncio's async-generator finalizer throws GeneratorExit into it. An
                # `except asyncio.CancelledError` alone would miss that GeneratorExit and
                # never mark the stream aborted, leaving the controller thread free to
                # keep streaming into an unbounded queue. Either way this must run before
                # the controller thread's next send() call.
                sse.mark_aborted()

        return StreamingResponse(gen(), status_code=200, media_type='text/event-stream',
                                 headers={**SSE_HEADERS, **cors_headers})

    return app


app = create_app()
