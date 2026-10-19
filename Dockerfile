FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ZVERTURET_HOST=0.0.0.0 \
    ZVERTURET_COOKIE_SECURE=true

WORKDIR /app
COPY app.py ./app.py
COPY static ./static
EXPOSE 8080
CMD ["python", "app.py"]
