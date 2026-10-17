"""Disposable database/runtime adapter for the new-data rollback gate.

PYTHONPATH selects either the current or previous edition. No production DSN
is accepted; the gate may only create/drop databases on the test instance.
"""

import asyncio
import os
import secrets
import sys
from urllib.parse import urlsplit

import asyncpg


async def database(action, name=None):
    dsn = os.environ["PORCHSITE_TEST_DSN"]
    parsed = urlsplit(dsn)
    if (
        parsed.hostname != "localhost"
        or parsed.port != 5433
        or parsed.username != "porchsite"
    ):
        raise RuntimeError("rollback data check requires porchsite@localhost:5433")
    connection = await asyncpg.connect(dsn)
    try:
        actual = await connection.fetchrow(
            "SELECT current_user AS role, current_setting('port') AS port"
        )
        if actual["role"] != "porchsite" or actual["port"] != "5433":
            raise RuntimeError("not the project's test PostgreSQL instance")
        if action == "create":
            name = "porchsite_rollback_" + secrets.token_hex(8)
            await connection.execute(f'CREATE DATABASE "{name}"')
            print(name)
        else:
            if (
                not name
                or not name.startswith("porchsite_rollback_")
                or not name.replace("_", "").isalnum()
            ):
                raise RuntimeError("not a rollback fixture database")
            await connection.execute(f'DROP DATABASE "{name}"')
    finally:
        await connection.close()


async def serve(current):
    import uvicorn
    from server.app.main import create_app
    from starlette.responses import JSONResponse

    app = create_app()

    async def wrapped(scope, receive, send):
        if current and scope.get("path") == "/__rollback/key":
            from server.app import keys

            await JSONResponse(await keys.create(app.pool, "Rollback fixture"))(
                scope, receive, send
            )
        elif current and scope.get("path") == "/__rollback/traffic":
            import time
            from server.app import agent_traffic
            await agent_traffic.settle(app.pool)
            await agent_traffic.flush(app.pool,time.time()*1000+60000)
            await JSONResponse({"ok":True})(scope,receive,send)
        elif current and scope.get("path") == "/__rollback/artifacts":
            try:
                rows=await app.pool.fetch('SELECT key,generation FROM public_artifacts ORDER BY key')
                await JSONResponse([dict(row) for row in rows])(scope,receive,send)
            except Exception:
                await JSONResponse({},status_code=404)(scope,receive,send)
        else:
            await app(scope, receive, send)

    async with app.started():
        server = uvicorn.Server(
            uvicorn.Config(
                wrapped,
                host="127.0.0.1",
                port=int(os.environ["ROLLBACK_PORT"]),
                lifespan="off",
                access_log=False,
            )
        )
        await server.serve()


if __name__ == "__main__":
    action = sys.argv[1]
    asyncio.run(
        serve(action == "serve-current")
        if action.startswith("serve-")
        else database(action, sys.argv[2] if len(sys.argv) > 2 else None)
    )
