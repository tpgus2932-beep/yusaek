"""Central configuration for external API clients."""
from __future__ import annotations

import os

ABLY_BASE = "https://api.a-bly.com"
ABLY_EMAIL = os.environ.get("ABLY_EMAIL", "eostm1997@naver.com")
ABLY_PASSWORD = os.environ.get("ABLY_PASSWORD", "!Glqgkqdldi1126")
# 이지오토(자동발주·판매처 송장등록) 웹 이전용 설정 - 비밀값은 backend/.env 에서만 읽는다.
EZAUTO_BASE = "http://ezauto.ezadmin.co.kr"
EZAUTO_DOMAIN = os.environ.get("EZAUTO_DOMAIN", "yusaek")
EZAUTO_HOST = os.environ.get("EZAUTO_HOST", "211.234.108.9")
EZAUTO_ABLY_SHOP_ID = os.environ.get("EZAUTO_ABLY_SHOP_ID", "10028")
ABLY_PARTNER_BASE = "https://partner.api.a-bly.com"  # 에이블리 공식(파트너) API - 이지오토가 사용하는 /v1/vendors
ABLY_VENDOR_API_KEY = os.environ.get("ABLY_VENDOR_API_KEY", "")  # 에이블리 공식 API(/v1/vendors) 고정 키
ABLY_VENDOR_TOKEN = os.environ.get("ABLY_VENDOR_TOKEN", "")  # 선택: 비어 있으면 이지어드민 이지오토 서버에서 받아온다
EZAUTO_AMOOD_SHOP_ID = os.environ.get("EZAUTO_AMOOD_SHOP_ID", "10080")
AMOOD_VENDOR_API_KEY = os.environ.get("AMOOD_VENDOR_API_KEY", "")  # 아모드 공식 API(x-amood-api-key) 고정 키
AMOOD_VENDOR_TOKEN = os.environ.get("AMOOD_VENDOR_TOKEN", "")  # 선택: 비어 있으면 이지오토 서버에서 받아온다
EZADMIN_BASE = "https://ga80.ezadmin.co.kr"
EZDESK_BASE = "https://ezdesk.ezadmin.co.kr"
EZADMIN_SESSION_KEY = "ezadmin_phpsessid"
EZDESK_SESSION_KEY = "ezdesk_phpsessid"
EZDESK_SMS_SENDER = "15339827"
PASTELCO_BASE = "https://api.pastelco.jp"
LLOGIS_LOGIN_URL = "https://partner.alps.llogis.com/auth/login"
LLOGIS_PID_BASE = "https://pid.alps.llogis.com:18210"
LLOGIS_TRB_BASE = "https://trb.alps.llogis.com:18230"
LLOGIS_PRINCIPAL = os.environ.get("LLOGIS_PRINCIPAL", "348867")
LLOGIS_CREDENTIAL = os.environ.get("LLOGIS_CREDENTIAL", "1q2w3e4r5t")
LLOGIS_EMP_NO = os.environ.get("LLOGIS_EMP_NO", "348867")
TOP90_BASE = "https://top90.sosolution.net"
TOP90_EMAIL = os.environ.get("TOP90_EMAIL", "")
TOP90_PASSWORD = os.environ.get("TOP90_PASSWORD", "")
ZIGZAG_BASE = "https://partners.kakaostyle.com"
ZIGZAG_EMAIL = os.environ.get("ZIGZAG_EMAIL", "eostm1997@naver.com")
ZIGZAG_PASSWORD = os.environ.get("ZIGZAG_PASSWORD", "!Tlqkfshadk1126")
ZIGZAG_SHOP_PATH = os.environ.get("ZIGZAG_SHOP_PATH", "cq-csuz03pn")
