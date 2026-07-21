"""Central configuration for external API clients."""
from __future__ import annotations

import os

ABLY_BASE = "https://api.a-bly.com"
ABLY_EMAIL = os.environ.get("ABLY_EMAIL", "eostm1997@naver.com")
ABLY_PASSWORD = os.environ.get("ABLY_PASSWORD", "!Glqgkqdldi1126")
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
