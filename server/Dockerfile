# The server edition (server/server/app) as one image. Build it from the
# repository root, so the shared looks (themes/) come along:
#   docker build -f server/Dockerfile -t porchsite .
# The supported setup is deploy/compose/ (app, PostgreSQL, Caddy).
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORCHSITE_THEMES=/srv/porchsite/themes

RUN useradd --system --create-home --home-dir /srv/porchsite --uid 10001 porchsite
WORKDIR /srv/porchsite

COPY server/pyproject.toml server/LICENSE ./src/
COPY server/server ./src/server
RUN pip install ./src && rm -rf ./src
COPY themes ./themes

USER porchsite
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"]

# Behind a reverse proxy on the same private network: trust its
# X-Forwarded-Proto/For so the site knows it is served over HTTPS.
CMD ["uvicorn", "server.app.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*", "--no-access-log"]
