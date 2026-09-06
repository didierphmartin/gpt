"""Entry point — the Python twin of backend/index.php.

One catch-all route. Per request: build Ctx → MiddlewareProcessor (CORS, auth) →
Dispatcher → controller(db, config).method(ctx, *params) → render(). Controllers are
synchronous (PyMySQL), so the whole pipeline runs in Starlette's threadpool.
"""
from __future__ import annotations

import traceback

from fastapi import FastAPI, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response

from app.config import load_config
from app.db import open_primary
from app.middleware.processor import MiddlewareProcessor
from app.routes import CONTROLLERS, ROUTES
from app.support.http import build_ctx, json_response, render
from app.support.logger import error_log, get_logger
from app.support.phpcompat import is_numeric, php_intval
from app.support.router import Dispatcher

METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']


def create_app(config: dict | None = None) -> FastAPI:
    config = config or load_config()
    get_logger()
    dispatcher = Dispatcher(ROUTES)
    processor = MiddlewareProcessor(config, lambda: open_primary(config))
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def handle_sync(request: Request, raw_body: bytes) -> Response:
        ctx = build_ctx(request, raw_body)
        cors_headers = processor.cors.headers(request.headers.get('origin', ''))

        def with_cors(resp: Response | None) -> Response | None:
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
                return with_cors(json_response(405, {'success': False, 'error': 'Method not allowed',
                                                     'allowed_methods': route.allowed}))
            controller_name, method_name = route.handler
            cls = CONTROLLERS.get(controller_name)
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
                resp = render(result)
                if resp is None:
                    # streaming_handled: the controller returned its own Response via ctx['_response']
                    resp = ctx.get('_response') or Response(status_code=200)
                return with_cors(resp)
            except Exception as e:  # noqa: BLE001
                error_log(f'[Backend] Controller error: {e}\n{traceback.format_exc()}')
                return with_cors(json_response(500, {'success': False, 'error': str(e)}))
        finally:
            db.close()

    @app.api_route('/{path:path}', methods=METHODS, include_in_schema=False)
    @app.api_route('/', methods=METHODS, include_in_schema=False)
    async def catch_all(request: Request):
        raw = await request.body()
        return await run_in_threadpool(handle_sync, request, raw)

    return app


app = create_app()
