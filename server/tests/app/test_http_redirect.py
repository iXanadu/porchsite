"""Transport redirect before content/auth/DB work; paired with the Worker."""
import httpx
from server.app.main import App
from server.app.settings import Settings

async def test_bl_http_redirect_before_database_or_body():
    app = App(Settings())  # Deliberately unstarted, without a database.
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as client:
        for host in ['site.example','www.site.example','192.0.2.1','localhost.example']:
            for path in ['/','/robots.txt','/wp-admin/install.php','/mcp?x=%2F&y=a+b']:
                for method in ['GET','HEAD','POST']:
                    response = await client.request(method, 'http://'+host+path, headers={'Authorization':'Bearer invalid'}, content='not-json' if method=='POST' else None)
                    assert response.status_code == 301
                    assert response.headers['location'] == 'https://'+host+path
                    assert response.headers['cache-control'] == 'no-store'
                    assert response.content == b''

async def test_bl_http_https_and_loopback_unchanged(http):
    for origin in ['https://site.example','http://localhost:8787','http://127.0.0.1:8787','http://127.42.0.7:8787','http://[::1]:8787']:
        response = await http.get(origin+'/.well-known/oauth-protected-resource/mcp')
        assert response.status_code == 200
        assert 'location' not in response.headers
        assert response.json()['resource'] == origin+'/mcp'
