"""TLS redirects belong to the proxy; plain HTTP upstream must work."""
from dataclasses import replace
import pytest
from server.app import oauth
from .web import MCP_HEADERS

@pytest.mark.parametrize('upstream',['http://127.0.0.1:8032','http://upstream.internal:8032'])
async def test_bl_http_proxied_plain_http_with_public_host(app, http, db, upstream):
    app.settings = replace(app.settings, site_url='https://site.example')
    headers = {'Host':'site.example'}
    for method in ['GET','HEAD']:
        response = await http.request(method,upstream+'/',headers=headers)
        assert response.status_code == 200
        assert 'location' not in response.headers
        if method == 'HEAD':
            assert response.content == b''
    token = await oauth.mint(db,'Helper','https://site.example')
    response = await http.post(upstream+'/mcp',headers={**MCP_HEADERS,**headers,'Authorization':'Bearer '+token},json={'jsonrpc':'2.0','id':1,'method':'tools/list'})
    assert response.status_code == 200
    assert 'location' not in response.headers
    assert response.json()['result']['tools']

async def test_bl_http_https_and_loopback_unchanged(http):
    for origin in ['https://site.example','http://site.example','http://localhost:8787','http://127.0.0.1:8787','http://127.42.0.7:8787','http://[::1]:8787']:
        response = await http.get(origin+'/.well-known/oauth-protected-resource/mcp')
        assert response.status_code == 200
        assert 'location' not in response.headers
        assert response.json()['resource'] == origin+'/mcp'
