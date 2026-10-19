"""Zverturet: a small, local-first video social app built with Python's stdlib."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
INSTANCE = ROOT / "instance"
DB_PATH = Path(os.environ.get("ZVERTURET_DB", str(INSTANCE / "zverturet.sqlite3")))
HOST = os.environ.get("ZVERTURET_HOST", "127.0.0.1")
PORT = int(os.environ.get("ZVERTURET_PORT", "5050"))
SECRET = os.environ.get("ZVERTURET_SECRET", "local-demo-secret-change-before-deploy")
SESSION_SECONDS = 7 * 24 * 60 * 60
PASSWORD_ROUNDS = 180_000


@contextmanager
def db_connection():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def password_digest(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ROUNDS)


def initialize_database() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db_connection() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                display_name TEXT NOT NULL,
                bio TEXT NOT NULL DEFAULT '',
                password_hash BLOB,
                password_salt BLOB,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS preferences (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                theme TEXT NOT NULL DEFAULT 'light' CHECK(theme IN ('light', 'dark'))
            );
            CREATE TABLE IF NOT EXISTS posts (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                caption TEXT NOT NULL,
                video_url TEXT NOT NULL,
                meme_text TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS likes (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, post_id)
            );
            CREATE TABLE IF NOT EXISTS reposts (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, post_id)
            );
            CREATE TABLE IF NOT EXISTS follows (
                follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                followed_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (follower_id, followed_id),
                CHECK (follower_id <> followed_id)
            );
            """
        )
        post_columns = {row["name"] for row in db.execute("PRAGMA table_info(posts)")}
        if "meme_text" not in post_columns:
            db.execute("ALTER TABLE posts ADD COLUMN meme_text TEXT NOT NULL DEFAULT ''")
        if db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
            now = int(time.time())
            salt = secrets.token_bytes(16)
            db.execute(
                "INSERT INTO users(username, display_name, bio, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                ("zverturet", "Zverturet", "Лента коротких историй.\nНайди свой ритм.", password_digest("12345678", salt), salt, now),
            )
            creators = [
                ("lumi.noir", "Луми", "Моменты, которые хочется сохранить."),
                ("lensline", "Линия кадра", "Замечаю свет в обычных местах."),
                ("nightarchive", "Ночной архив", "Город звучит после заката."),
                ("studiomin", "Студия Мин", "Немного движения каждый день."),
            ]
            for username, display_name, bio in creators:
                db.execute(
                    "INSERT INTO users(username, display_name, bio, created_at) VALUES (?, ?, ?, ?)",
                    (username, display_name, bio, now),
                )
            db.execute("INSERT INTO preferences(user_id, theme) VALUES (1, 'light')")
            demo_clips = [
                ("clip-flower", "lumi.noir", "Тишина тоже умеет цвести. 🌿", "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"),
                ("clip-escape", "lensline", "Свернуть туда, где больше воздуха.", "https://media.w3.org/2010/05/sintel/trailer.mp4"),
                ("clip-joyride", "nightarchive", "Ночной маршрут без плана.", "https://media.w3.org/2010/05/video/movie_300.mp4"),
                ("clip-bunny", "studiomin", "Маленький повод улыбнуться сегодня.", "https://media.w3.org/2010/05/bunny/trailer.mp4"),
                ("clip-own", "zverturet", "Красота часто совсем рядом.", "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"),
            ]
            creator_ids = {row["username"]: row["id"] for row in db.execute("SELECT id, username FROM users")}
            for index, (post_id, username, caption, url) in enumerate(demo_clips):
                db.execute(
                    "INSERT INTO posts(id, user_id, caption, video_url, created_at) VALUES (?, ?, ?, ?, ?)",
                    (post_id, creator_ids[username], caption, url, now - index * 3600),
                )
            # Seed a few genuine relationship rows so the demo profile has useful numbers.
            for peer_id in (2, 3, 4, 5):
                db.execute("INSERT INTO likes(user_id, post_id, created_at) VALUES (?, 'clip-own', ?)", (peer_id, now))
            for peer_id in (2, 3):
                db.execute("INSERT INTO follows(follower_id, followed_id, created_at) VALUES (?, 1, ?)", (peer_id, now))
            for peer_id, post_id in ((1, "clip-flower"), (2, "clip-escape"), (3, "clip-joyride"), (4, "clip-bunny")):
                db.execute("INSERT INTO likes(user_id, post_id, created_at) VALUES (?, ?, ?)", (peer_id, post_id, now))
        # Keep bundled demo posts on known public sample hosts across app upgrades.
        for post_id, url in (
            ("clip-escape", "https://media.w3.org/2010/05/sintel/trailer.mp4"),
            ("clip-joyride", "https://media.w3.org/2010/05/video/movie_300.mp4"),
            ("clip-bunny", "https://media.w3.org/2010/05/bunny/trailer.mp4"),
        ):
            db.execute("UPDATE posts SET video_url=? WHERE id=?", (url, post_id))
        creator_ids = {row["username"]: row["id"] for row in db.execute("SELECT id, username FROM users")}
        meme_posts = [
            ("meme-01", "studiomin", "Я НА 5 МИНУТ ПРИЛЯГУ\nПОНЕДЕЛЬНИК: ПРОШЛО 3 ЧАСА", "Планировал короткую паузу. Получился отпуск без предупреждения.", "https://media.w3.org/2010/05/bunny/trailer.mp4"),
            ("meme-02", "nightarchive", "УЖЕ НАПИСАЛ «Я ВЫХОЖУ»\nКЛЮЧИ: ВСЁ ЕЩЁ ДОМА", "Встреча с реальностью состоится через пару минут.", "https://media.w3.org/2010/05/video/movie_300.mp4"),
            ("meme-03", "lumi.noir", "МОЙ МОЗГ В 02:47\n«ДАВАЙ ВСПОМНИМ 2014 ГОД»", "Ночной архив неловких воспоминаний снова открыт.", "https://media.w3.org/2010/05/sintel/trailer.mp4"),
            ("meme-04", "lensline", "ОТКРЫЛ ОДНУ ВКЛАДКУ\nИХ УЖЕ 27", "Вкладки размножаются, пока никто не смотрит.", "https://media.w3.org/2010/05/video/movie_300.mp4"),
            ("meme-05", "studiomin", "ПЛАН: БЫТЬ ПРОДУКТИВНЫМ\nЯ: КОФЕ СНАЧАЛА", "Мотивация загружается… 1%.", "https://media.w3.org/2010/05/bunny/trailer.mp4"),
            ("meme-06", "nightarchive", "КОГДА НАШЁЛ МЕМ\nИ ОТПРАВИЛ ВСЕМ", "Если узнал себя — это уже коллективный мем.", "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"),
        ]
        now = int(time.time())
        for index, (post_id, username, meme_text, caption, url) in enumerate(meme_posts):
            db.execute(
                "INSERT OR IGNORE INTO posts(id, user_id, caption, video_url, meme_text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (post_id, creator_ids[username], caption, url, meme_text, now - index * 900),
            )


def make_session(user_id: int) -> str:
    expiry = int(time.time()) + SESSION_SECONDS
    body = f"{user_id}:{expiry}".encode()
    sig = hmac.new(SECRET.encode(), body, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(body + b":" + sig).decode().rstrip("=")


def read_session(token: str | None) -> int | None:
    if not token:
        return None
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        user_id_text, expiry_text, signature = raw.split(b":", 2)
        body = user_id_text + b":" + expiry_text
        expected = hmac.new(SECRET.encode(), body, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected) or int(expiry_text) < int(time.time()):
            return None
        return int(user_id_text)
    except (ValueError, TypeError):
        return None


class ZverturetHandler(BaseHTTPRequestHandler):
    server_version = "Zverturet/1.0"

    def log_message(self, fmt: str, *args) -> None:
        # Keep local development output readable while still showing each request.
        print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

    def send_json(self, status: int, payload: dict, headers: dict[str, str] | None = None) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if headers:
            for key, value in headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 64_000:
            raise ValueError("Слишком большой запрос.")
        raw = self.rfile.read(length) if length else b"{}"
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("Ожидался объект JSON.")
        return value

    def current_user_id(self) -> int | None:
        cookie = self.headers.get("Cookie", "")
        token = None
        for item in cookie.split(";"):
            key, sep, value = item.strip().partition("=")
            if sep and key == "zv_session":
                token = value
                break
        return read_session(token)

    def require_user(self) -> int | None:
        user_id = self.current_user_id()
        if user_id is None:
            self.send_json(401, {"error": "Войдите, чтобы продолжить."})
        return user_id

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/" or parsed.path == "/index.html":
            self.serve_file(STATIC / "index.html")
            return
        if parsed.path.startswith("/static/"):
            relative = unquote(parsed.path[len("/static/"):])
            target = (STATIC / relative).resolve()
            if target != STATIC.resolve() and STATIC.resolve() not in target.parents:
                self.send_error(404)
                return
            self.serve_file(target)
            return
        if parsed.path == "/api/me":
            user_id = self.require_user()
            if user_id is None:
                return
            self.send_json(200, {"user": self.user_payload(user_id)})
            return
        if parsed.path == "/api/feed":
            user_id = self.require_user()
            if user_id is None:
                return
            query = parse_qs(parsed.query)
            following_only = query.get("following", ["0"])[0] == "1"
            with db_connection() as db:
                filter_sql = "AND p.user_id IN (SELECT followed_id FROM follows WHERE follower_id = ?)" if following_only else ""
                rows = db.execute(
                    f"""
                    SELECT p.id, p.caption, p.video_url, p.meme_text, p.created_at, u.id AS author_id,
                           u.username, u.display_name,
                           (SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) AS likes_count,
                           (SELECT COUNT(*) FROM reposts r WHERE r.post_id=p.id) AS reposts_count,
                           EXISTS(SELECT 1 FROM likes l WHERE l.post_id=p.id AND l.user_id=?) AS liked,
                           EXISTS(SELECT 1 FROM reposts r WHERE r.post_id=p.id AND r.user_id=?) AS reposted,
                           EXISTS(SELECT 1 FROM follows f WHERE f.followed_id=u.id AND f.follower_id=?) AS is_following,
                           p.user_id = ? AS is_own
                    FROM posts p JOIN users u ON u.id=p.user_id
                    WHERE 1=1 {filter_sql}
                    ORDER BY p.created_at DESC, p.id DESC
                    """,
                    (user_id, user_id, user_id, user_id, user_id) if following_only else (user_id, user_id, user_id, user_id),
                ).fetchall()
            self.send_json(200, {"posts": [dict(row) for row in rows]})
            return
        if parsed.path == "/api/suggestions":
            user_id = self.require_user()
            if user_id is None:
                return
            with db_connection() as db:
                rows = db.execute(
                    """SELECT u.id, u.username, u.display_name,
                       EXISTS(SELECT 1 FROM follows f WHERE f.followed_id=u.id AND f.follower_id=?) AS is_following
                       FROM users u WHERE u.id<>? ORDER BY u.id LIMIT 8""",
                    (user_id, user_id),
                ).fetchall()
            self.send_json(200, {"users": [dict(row) for row in rows]})
            return
        self.send_error(404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/login":
            self.login()
            return
        if parsed.path == "/api/register":
            self.register()
            return
        if parsed.path == "/api/logout":
            self.send_json(200, {"ok": True}, {"Set-Cookie": "zv_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"})
            return
        user_id = self.require_user()
        if user_id is None:
            return
        match = re.fullmatch(r"/api/posts/([^/]+)/(like|repost)", parsed.path)
        if match:
            self.toggle_post_action(user_id, match.group(1), match.group(2))
            return
        match = re.fullmatch(r"/api/users/(\d+)/follow", parsed.path)
        if match:
            self.toggle_follow(user_id, int(match.group(1)))
            return
        self.send_json(404, {"error": "Маршрут не найден."})

    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        user_id = self.require_user()
        if user_id is None:
            return
        try:
            body = self.read_json()
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            self.send_json(400, {"error": str(exc) or "Некорректный JSON."})
            return
        if parsed.path == "/api/profile":
            self.update_profile(user_id, body)
            return
        if parsed.path == "/api/preferences":
            theme = body.get("theme")
            if theme not in ("light", "dark"):
                self.send_json(400, {"error": "Выберите светлую или тёмную тему."})
                return
            with db_connection() as db:
                db.execute("INSERT INTO preferences(user_id, theme) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme", (user_id, theme))
            self.send_json(200, {"theme": theme})
            return
        self.send_json(404, {"error": "Маршрут не найден."})

    def register(self) -> None:
        try:
            body = self.read_json()
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"error": "Проверьте данные формы."})
            return

        username = str(body.get("username", "")).strip().lstrip("@").lower()
        display_name = str(body.get("display_name", "")).strip()
        password = str(body.get("password", ""))
        if not re.fullmatch(r"[a-z0-9_.]{3,24}", username):
            self.send_json(400, {"error": "Логин: 3–24 символа, латинские буквы, цифры, точка или подчёркивание."})
            return
        if not 1 <= len(display_name) <= 40:
            self.send_json(400, {"error": "Имя должно содержать от 1 до 40 символов."})
            return
        missing_rules = []
        if len(password) < 8:
            missing_rules.append("не менее 8 символов")
        if len(password) > 128:
            missing_rules.append("не более 128 символов")
        if not re.search(r"[A-Z]", password):
            missing_rules.append("заглавную латинскую букву")
        if not re.search(r"[a-z]", password):
            missing_rules.append("строчную латинскую букву")
        if not any(char.isdigit() for char in password):
            missing_rules.append("цифру")
        if not any(not char.isalnum() and not char.isspace() for char in password):
            missing_rules.append("спецсимвол, например ! или #")
        if missing_rules:
            self.send_json(400, {"error": "Добавь в пароль: " + ", ".join(missing_rules) + "."})
            return

        salt = secrets.token_bytes(16)
        try:
            with db_connection() as db:
                cursor = db.execute(
                    "INSERT INTO users(username, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
                    (username, display_name, password_digest(password, salt), salt, int(time.time())),
                )
                user_id = cursor.lastrowid
                db.execute("INSERT INTO preferences(user_id, theme) VALUES (?, 'light')", (user_id,))
        except sqlite3.IntegrityError:
            self.send_json(409, {"error": "Этот логин уже занят."})
            return
        self.send_json(
            201,
            {"ok": True, "user": self.user_payload(user_id)},
            {"Set-Cookie": f"zv_session={make_session(user_id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_SECONDS}"},
        )

    def login(self) -> None:
        try:
            body = self.read_json()
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"error": "Проверьте данные формы."})
            return
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        with db_connection() as db:
            user = db.execute("SELECT id, password_hash, password_salt FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone()
        valid = bool(user and user["password_hash"] and hmac.compare_digest(password_digest(password, user["password_salt"]), user["password_hash"]))
        if not valid:
            self.send_json(401, {"error": "Неверный логин или пароль."})
            return
        self.send_json(200, {"ok": True, "user": self.user_payload(user["id"])}, {"Set-Cookie": f"zv_session={make_session(user['id'])}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_SECONDS}"})

    def user_payload(self, user_id: int) -> dict:
        with db_connection() as db:
            user = db.execute(
                """SELECT u.id, u.username, u.display_name, u.bio,
                   COALESCE(p.theme, 'light') AS theme,
                   (SELECT COUNT(*) FROM posts WHERE user_id=u.id) AS posts_count,
                   (SELECT COUNT(*) FROM likes l JOIN posts x ON x.id=l.post_id WHERE x.user_id=u.id) AS likes_received,
                   (SELECT COUNT(*) FROM follows WHERE followed_id=u.id) AS followers_count,
                   (SELECT COUNT(*) FROM follows WHERE follower_id=u.id) AS following_count
                   FROM users u LEFT JOIN preferences p ON p.user_id=u.id WHERE u.id=?""",
                (user_id,),
            ).fetchone()
        return dict(user) if user else {}

    def toggle_post_action(self, user_id: int, post_id: str, action: str) -> None:
        table = "likes" if action == "like" else "reposts"
        with db_connection() as db:
            if not db.execute("SELECT 1 FROM posts WHERE id=?", (post_id,)).fetchone():
                self.send_json(404, {"error": "Публикация не найдена."})
                return
            removed = db.execute(f"DELETE FROM {table} WHERE user_id=? AND post_id=?", (user_id, post_id)).rowcount > 0
            if not removed:
                db.execute(f"INSERT INTO {table}(user_id, post_id, created_at) VALUES (?, ?, ?)", (user_id, post_id, int(time.time())))
            count = db.execute(f"SELECT COUNT(*) FROM {table} WHERE post_id=?", (post_id,)).fetchone()[0]
        self.send_json(200, {"active": not removed, "count": count})

    def toggle_follow(self, user_id: int, target_id: int) -> None:
        if user_id == target_id:
            self.send_json(400, {"error": "Нельзя подписаться на свой профиль."})
            return
        with db_connection() as db:
            if not db.execute("SELECT 1 FROM users WHERE id=?", (target_id,)).fetchone():
                self.send_json(404, {"error": "Профиль не найден."})
                return
            removed = db.execute("DELETE FROM follows WHERE follower_id=? AND followed_id=?", (user_id, target_id)).rowcount > 0
            if not removed:
                db.execute("INSERT INTO follows(follower_id, followed_id, created_at) VALUES (?, ?, ?)", (user_id, target_id, int(time.time())))
            followers = db.execute("SELECT COUNT(*) FROM follows WHERE followed_id=?", (target_id,)).fetchone()[0]
            following = db.execute("SELECT COUNT(*) FROM follows WHERE follower_id=?", (user_id,)).fetchone()[0]
        self.send_json(200, {"following": not removed, "followers_count": followers, "following_count": following})

    def update_profile(self, user_id: int, body: dict) -> None:
        display_name = str(body.get("display_name", "")).strip()
        username = str(body.get("username", "")).strip().lstrip("@").lower()
        bio = str(body.get("bio", "")).strip()
        if not 1 <= len(display_name) <= 40:
            self.send_json(400, {"error": "Имя должно содержать от 1 до 40 символов."})
            return
        if not re.fullmatch(r"[a-z0-9_.]{3,24}", username):
            self.send_json(400, {"error": "Логин: 3–24 символа, латинские буквы, цифры, точка или подчёркивание."})
            return
        if len(bio) > 120:
            self.send_json(400, {"error": "Описание должно быть не длиннее 120 символов."})
            return
        try:
            with db_connection() as db:
                db.execute("UPDATE users SET username=?, display_name=?, bio=? WHERE id=?", (username, display_name, bio, user_id))
        except sqlite3.IntegrityError:
            self.send_json(409, {"error": "Этот логин уже занят."})
            return
        self.send_json(200, {"user": self.user_payload(user_id)})

    def serve_file(self, path: Path) -> None:
        if not path.is_file():
            self.send_error(404)
            return
        content = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix == ".js":
            content_type = "text/javascript"
        if path.suffix == ".css":
            content_type = "text/css"
        if path.suffix in (".html", ".js", ".css"):
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Allow", "GET, POST, PATCH, OPTIONS")
        self.end_headers()


def main() -> None:
    initialize_database()
    server = ThreadingHTTPServer((HOST, PORT), ZverturetHandler)
    print(f"Zverturet is ready at http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nZverturet stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
