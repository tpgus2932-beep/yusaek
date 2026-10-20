"""EZAdmin / EZDesk 자동 로그인 - 만료된 PHPSESSID를 서버가 직접 재발급한다.

계정은 환경변수(EZADMIN_LOGIN_DOMAIN/ID/PW, EZDESK_LOGIN_DOMAIN/ID/PW; EZDESK_*가
비어 있으면 EZADMIN_* 재사용)에서만 읽는다. 하나라도 비면 자동 로그인은 꺼지고
기존처럼 사용자가 PHPSESSID를 직접 붙여넣는 흐름으로 돌아간다."""
from __future__ import annotations

import asyncio
import os
import re
import secrets
from typing import Callable
from urllib.parse import quote_plus

import httpx

from . import config

_UA = {"User-Agent": "Mozilla/5.0"}
_lock = asyncio.Lock()
_set_setting: Callable[[str, str | None], None] | None = None


def register_setting_writer(set_setting: Callable[[str, str | None], None]) -> None:
    """main.py가 startup에 한 번 등록 - SDK가 새 PHPSESSID를 app_settings에 저장할 때 쓴다."""
    global _set_setting
    _set_setting = set_setting


def _creds(prefix: str) -> tuple[str, str, str] | None:
    def env(name: str) -> str:
        return (os.environ.get(f"{prefix}_{name}") or os.environ.get(f"EZADMIN_LOGIN_{name}") or "").strip()
    domain, userid, passwd = env("DOMAIN"), env("ID"), env("PW")
    return (domain, userid, passwd) if domain and userid and passwd else None


def autologin_enabled(kind: str = "ezadmin") -> bool:
    return _set_setting is not None and _creds("EZADMIN_LOGIN" if kind == "ezadmin" else "EZDESK_LOGIN") is not None


def _rsa_encrypt_hex(plain: str, modulus_hex: str, exponent_hex: str) -> str:
    """ga80 로그인 페이지의 rsa.js(RSAKey.encrypt, PKCS#1 v1.5 type 2)와 동일한 결과를 낸다."""
    n, e = int(modulus_hex, 16), int(exponent_hex, 16)
    size = (n.bit_length() + 7) // 8
    msg = plain.encode("utf-8")
    if len(msg) > size - 11:
        raise ValueError("login payload too long for RSA key")
    pad = bytes(secrets.choice(range(1, 256)) for _ in range(size - len(msg) - 3))
    block = b"\x00\x02" + pad + b"\x00" + msg
    return format(pow(int.from_bytes(block, "big"), e, n), "x").rjust(size * 2, "0")


async def login_ezadmin() -> str:
    """ga80 로그인 → 새 PHPSESSID. 실패 시 RuntimeError."""
    creds = _creds("EZADMIN_LOGIN")
    if not creds:
        raise RuntimeError("EZADMIN_LOGIN_DOMAIN/ID/PW 환경변수가 설정되지 않았습니다")
    domain, userid, passwd = creds
    async with httpx.AsyncClient(timeout=20.0, verify=False, follow_redirects=True, headers=_UA) as client:
        page = (await client.get(f"{config.EZADMIN_BASE}/login.htm")).text
        key = re.search(r'setPublic\(\s*"([0-9a-fA-F]+)"\s*,\s*"([0-9a-fA-F]+)"', page)
        if not key:
            raise RuntimeError("EZAdmin 로그인 페이지에서 RSA 공개키를 찾지 못했습니다")
        crdate = (re.search(r'name="?crdate"?[^>]*value="([^"]*)"', page) or re.search(r'value="([^"]*)"[^>]*name="?crdate', page))
        # jQuery serialize()와 같은 순서/인코딩: crdate, domain, userid, passwd
        serialized = "&".join(
            f"{k}={quote_plus(v)}" for k, v in (("crdate", crdate.group(1) if crdate else ""), ("domain", domain), ("userid", userid), ("passwd", passwd))
        )
        encpar = _rsa_encrypt_hex(serialized, key.group(1), key.group(2))
        resp = await client.post(f"{config.EZADMIN_BASE}/login_process.php", data={"encpar": encpar}, headers={"Referer": f"{config.EZADMIN_BASE}/login.htm"})
        sid = client.cookies.get("PHPSESSID")
        body = resp.text or ""
        if not sid or "login.htm" in str(resp.url) or "login_form" in body.lower():
            raise RuntimeError(f"EZAdmin 로그인 실패 (HTTP {resp.status_code}) - 도메인/아이디/비밀번호를 확인하세요")
        return sid


async def login_ezdesk() -> str:
    """ezdesk 로그인 → 새 PHPSESSID. 실패 시 RuntimeError."""
    creds = _creds("EZDESK_LOGIN")
    if not creds:
        raise RuntimeError("EZDESK_LOGIN_* (또는 EZADMIN_LOGIN_*) 환경변수가 설정되지 않았습니다")
    domain, userid, passwd = creds
    async with httpx.AsyncClient(timeout=20.0, verify=False, follow_redirects=True, headers=_UA) as client:
        await client.get(f"{config.EZDESK_BASE}/login.html")
        resp = await client.post(
            f"{config.EZDESK_BASE}/login_ok.php",
            data={"domain": domain, "userid": userid, "passwd": passwd, "remember": "1"},
            headers={"Referer": f"{config.EZDESK_BASE}/login.html"},
        )
        sid = client.cookies.get("PHPSESSID")
        if not sid or "login.html" in str(resp.url):
            raise RuntimeError(f"EZDesk 로그인 실패 (HTTP {resp.status_code}) - 도메인/아이디/비밀번호를 확인하세요")
        return sid


async def relogin(kind: str = "ezadmin") -> str | None:
    """자동 로그인 후 app_settings에 새 PHPSESSID 저장. 비활성/실패면 None (호출자는 기존 만료 흐름 유지)."""
    if not autologin_enabled(kind):
        return None
    key = config.EZADMIN_SESSION_KEY if kind == "ezadmin" else config.EZDESK_SESSION_KEY
    async with _lock:  # 동시에 만료를 만난 요청들이 로그인을 중복 호출하지 않게
        try:
            sid = await (login_ezadmin() if kind == "ezadmin" else login_ezdesk())
        except Exception as exc:
            print(f"[ezadmin-autologin] {kind} 로그인 실패: {exc}")
            return None
        _set_setting(key, sid)
        print(f"[ezadmin-autologin] {kind} 세션 갱신 완료")
        return sid


async def keepalive_loop(get_setting, interval_sec: int = 600) -> None:
    """주기적으로 세션 유효성을 점검하고 만료돼 있으면 재로그인 - raw httpx로 세션을 직접 읽는 라우터들도 혜택을 본다."""
    from .ezadmin import EzAdminClient, EzAdminSessionExpired, EzDeskSessionExpired

    while True:
        await asyncio.sleep(interval_sec)
        client = EzAdminClient(get_setting)
        for kind, probe in (
            ("ezadmin", lambda: client.query_orders("x", start_date="2026-01-01", end_date="2026-01-01", rows=1)),
            ("ezdesk", lambda: client.sms_chat_detail("01000000000", config.EZDESK_SMS_SENDER)),
        ):
            if not autologin_enabled(kind):
                continue
            try:
                await probe()
            except (EzAdminSessionExpired, EzDeskSessionExpired):
                await relogin(kind)
            except Exception as exc:
                print(f"[ezadmin-autologin] {kind} 점검 중 오류(무시): {exc}")
