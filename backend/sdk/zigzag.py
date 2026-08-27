from __future__ import annotations
from typing import Any
import asyncio
import re
import httpx
from . import config

_RETURN_CLAIM_QUERY = """
    query GetPartnerReturnClaimList($request_status_list: [OrderItemRequestStatus!]!, $is_deferred: Boolean, $order_item_number_list: [String!], $due_date_ymd_complete_lte: Int, $due_date_ymd_mark_return_collecting_lte: Int, $date_requested_ymd_gte: Int, $date_requested_ymd_lte: Int, $date_completed_ymd_gte: Int, $date_completed_ymd_lte: Int, $date_marked_return_collected_ymd_gte: Int, $date_marked_return_collected_ymd_lte: Int, $date_awaiting_additional_payment_gte: Int, $date_awaiting_additional_payment_lte: Int, $page: Int, $items_per_page: Int, $order_by: OrderItemListOrderType, $order_search_param: OrderSearchParamFilter!, $order_item_search_param: OrderItemSearchParamFilter!, $order_item_parent_shop_search_param: OrderItemParentShopSearchParamFilter, $next_status_after_additional_payment_list: [OrderItemRequestStatus!], $is_awaiting_additional_payment: Boolean) {
  partner_claim_list(
    request_status_list: $request_status_list
    is_deferred: $is_deferred
    order_item_number_list: $order_item_number_list
    due_date_ymd_complete_lte: $due_date_ymd_complete_lte
    due_date_ymd_mark_return_collecting_lte: $due_date_ymd_mark_return_collecting_lte
    date_requested_ymd_gte: $date_requested_ymd_gte
    date_requested_ymd_lte: $date_requested_ymd_lte
    date_completed_ymd_gte: $date_completed_ymd_gte
    date_completed_ymd_lte: $date_completed_ymd_lte
    date_marked_return_collected_ymd_gte: $date_marked_return_collected_ymd_gte
    date_marked_return_collected_ymd_lte: $date_marked_return_collected_ymd_lte
    date_awaiting_additional_payment_gte: $date_awaiting_additional_payment_gte
    date_awaiting_additional_payment_lte: $date_awaiting_additional_payment_lte
    page: $page
    items_per_page: $items_per_page
    order_by: $order_by
    order_search_param: $order_search_param
    order_item_search_param: $order_item_search_param
    order_item_parent_shop_search_param: $order_item_parent_shop_search_param
    next_status_after_additional_payment_list: $next_status_after_additional_payment_list
    is_awaiting_additional_payment: $is_awaiting_additional_payment
  ) {
    total_count
    item_list {
      order_item_request_number
      date_requested
      status
      requested_quantity
      requested_reason_category
      requested_reason
      due_date_mark_return_collecting
      date_marked_return_collecting
      date_marked_return_collected
      due_date_complete
      date_completed
      next_status_after_additional_payment
      claim_additional_payment_list {
        date_paid
      }
      date_awaiting_additional_payment
      requested_account_info {
        account_type
      }
      collecting_type
      shipping_fee_additional_charge_method {
        initial
        return
      }
      shipping_company
      invoice_number
      deferred_count
      active_defer {
        date_created
      }
      requested_product_price_detail {
        original_price
        product_price
        promotion_discount_price
      }
      requested_payment_amount_detail {
        cash_amount
        coupon_discount_amount
        mileage_amount
        point_amount
        allotment_detail {
          seller_coupon_allotment_amount
          seller_mileage_allotment_amount
        }
      }
      order_item {
        ...OrderItemInfo
        shipping_company
        invoice_number
        date_created
        shop_name
        shipping_fee_type
        shipping_memo
        shipping_group_id
        receiver {
          name
          mobile_tel
          postcode
          address1
          address2
        }
        order {
          order_number
          version
          date_paid
          payment_method
          refund_bank_account_required
          orderer {
            name
            email
            mobile_tel
          }
        }
        shipping_group {
          total_shipping_fee
          shipping_info {
            extra_shipping_fee
          }
          promotion_shipping_address_title
          shipping_group_payment_shipping_fee_list {
            paid_coupon_total_shipping_fee
            coupon_discount_allotment_amount {
              seller_amount
            }
          }
        }
        order_shop_seller_memo_count_info {
          total_count
          important_count
        }
        zpay_discount_info {
          discount_amount
          discount_unit_amount
        }
        payment_amount {
          coupon_discount_amount
          coupon_discount_allotment_amount {
            seller_amount
          }
          paid_mileage_amount
          mileage_allotment_amount {
            seller_amount
          }
        }
      }
      attachment_list {
        id
        thumbnail_url
        original_url
      }
    }
  }
  goods_flow_contract_list(status_list: [Approved]) {
    item_list {
      id
      status
      shipping_company
    }
  }
}

fragment OrderItemInfo on OrderItem {
  id
  order {
    id
    date_paid
    site_id
    order_number
    payment_method
    orderer {
      name
      mobile_tel
      email
    }
    country
    order_promotion_list {
      order_promotion_item_list {
        order_promotion {
          threshold_qualifying_non_promotion_order_item_ids
          promotion_type
          promotion {
            promotion_detail_type_name
          }
        }
      }
    }
  }
  receiver {
    name
    mobile_tel
    postcode
    address1
    address2
  }
  product_info {
    name
    price
    options
    option_detail_list {
      name
      value
      kr_name
      kr_value
    }
    product_code
    custom_product_code
    product_item_code
    custom_product_item_code
  }
  order_promotion_item {
    order_promotion {
      promotion_id
      promotion_title
      promotion_type
      promotion_detail_type
      min_required_amount
      applied_quantity
      promotion {
        promotion_type_name
        promotion_detail_type_name
      }
    }
    order_promotion_item_group_id
    promotion_applied_item_discount_price
  }
  order_promotion_shipping_fee_item {
    order_promotion {
      promotion_type
      promotion {
        promotion_type_name
        promotion_detail_type_name
      }
    }
  }
  order_item_product {
    tax_type
    option_type
    image_url
    option_detail_list {
      name
      value
      kr_name
      kr_value
    }
    options
    kr_options
    name
    kr_name
    product_detail_info {
      shipping_days
      bundle_type
      trait_list
    }
  }
  order_item_overseas_direct_purchase {
    date_succeeded
  }
  shop_id
  quantity
  status
  order_item_number
  total_amount
  product_id
  site_id
  country
  date_shipment_process_requested
  fulfillment_type
}
"""


_CATEGORY_TREE_QUERY = """
    query GetRecentManagedCategoryVersion {
  getRecentManagedCategoryVersion {
    id
    category_type
    category_list {
      id
      name
      parent_id
      category_status
      sibling_order
      children {
        id
        key
        name
        parent_id
        category_status
        sibling_order
        children {
          id
          key
          name
          parent_id
          category_status
          sibling_order
          children {
            id
            key
            name
            parent_id
            category_status
            sibling_order
            children {
              id
              key
              name
              parent_id
              category_status
              sibling_order
            }
          }
        }
      }
    }
  }
}
    """

_PRESIGNED_URL_QUERY = """
    query GetCatalogUploadPreSignedUrl($input: CatalogUploadInput!) {
  catalog_upload_pre_signed_url(upload_input: $input) {
    pre_signed_url
    file_name
    key
    origin_url
  }
}
    """

_CREATE_PRODUCT_MUTATION = """
    mutation CreateCatalogProduct($productInput: CatalogProductInput!) {
  createCatalogProduct(productInput: $productInput)
}
    """

_SEARCHED_PRODUCT_PLAIN_LIST_QUERY = """
    query GetSearchedProductPlainList($input: SearchProductPlainInput!) {
  searched_product_plain_list(input: $input) {
    total_count
    item_list {
      id
    }
  }
}
    """

_CACHED_PRODUCT_LIST_QUERY = """
    query GetCachedProductListInProductManagement($input: CachedProductListInput!) {
  cached_product_list(input: $input) {
    product_list {
      id
      name
      product_code
    }
  }
}
    """

_EXCEL_UPLOAD_PRESIGNED_URL_QUERY = """
    query GetExcelUploadPreSignedUrl($input: CatalogExcelUploadInput!) {
  excel_upload_pre_signed_url(input: $input) {
    pre_signed_url
    origin_file_name
    s3_file_name
    key
  }
}
    """

_SEND_EXCEL_IMPORT_FILE_MUTATION = """
    mutation SendExcelImportFile($input: CatalogSendExcelImportFileInput!) {
  sendExcelImportFile(input: $input)
}
    """

_UPDATE_PRODUCT_PRICE_BY_FILE_MUTATION = """
    mutation UpdateProductPriceByFile($id: String!) {
  updateProductPriceByFile(id: $id)
}
    """

_EXCEL_IMPORT_FILE_LIST_QUERY = """
    query GetExcelImportFileList($input: CatalogExcelImportFileListInput!) {
  excel_import_file_list(input: $input) {
    item_list {
      id
      shop_id
      file_name
      status
      auditor
      updated_at
      import_type
    }
    total_count
  }
}
    """


class ZigzagLoginError(RuntimeError):
    pass


def _normalize_phone(phone: str | None) -> str:
    return re.sub(r"\D", "", phone or "")


# 반품 배송비를 누가 부담하는지로 단순변심/판매자과실을 구분한다.
# 반품사유코드(requested_reason_category)는 값이 너무 다양해 신뢰할 수 없어서,
# shipping_fee_additional_charge_method.return을 기준으로 삼는다 - 실제 캡처 2건으로 확인:
#   DEDUCT_FROM_REFUND_PAYMENT(반품비를 환불금에서 차감=구매자 부담) → 단순변심(고객)
#   NOT_REQUIRED(반품비 청구 안 함=판매자 부담) → 판매자과실(판매자)
# 이 두 값 외의 값은 실제로 본 적이 없어 임의로 매핑하지 않고 빈 문자열(미확인)로 둔다.
_CHARGE_METHOD_LABELS = {
    "DEDUCT_FROM_REFUND_PAYMENT": "고객",
    "NOT_REQUIRED": "판매자",
}


def classify_return_charge_method(charge_method: str | None) -> str:
    return _CHARGE_METHOD_LABELS.get(charge_method or "", "")


class ZigzagClient:
    """지그재그 파트너센터(partners.kakaostyle.com) 클라이언트.

    이메일/비밀번호 로그인 후 세션 쿠키를 그대로 재사용하는 방식이라
    (Authorization 헤더 없음 - 실제 브라우저 캡처로 확인), 인스턴스 하나가
    물고 있는 httpx.AsyncClient를 계속 재사용해야 한다. 요청 하나 끝날 때마다
    새로 만드는 AblyClient 패턴과 달리, 반드시 같은 클라이언트로 재사용할 것.
    """

    def __init__(self, *, timeout: float = 20.0):
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None

    async def _login(self, client: httpx.AsyncClient) -> None:
        response = await client.post(
            f"{config.ZIGZAG_BASE}/api/provider/login",
            json={
                "identifier": config.ZIGZAG_EMAIL,
                "password": config.ZIGZAG_PASSWORD,
                "mfa_code": None,
                "is_app": False,
            },
        )
        if not response.is_success:
            raise ZigzagLoginError(f"지그재그 로그인 실패 (status={response.status_code})")

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            client = httpx.AsyncClient(
                timeout=self._timeout,
                headers={
                    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
                    "accept": "application/json, text/plain, */*",
                    "content-type": "application/json",
                    "origin": config.ZIGZAG_BASE,
                },
            )
            try:
                await self._login(client)
            except Exception:
                await client.aclose()
                raise
            self._client = client
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _graphql(self, shop_path: str, operation: str, query: str, variables: dict) -> dict:
        client = await self._get_client()
        url = f"{config.ZIGZAG_BASE}/api/provider/{shop_path}/graphql/{operation}"
        response = await client.post(url, json={"query": query, "variables": variables})
        if response.status_code in (401, 403):
            await self._login(client)
            response = await client.post(url, json={"query": query, "variables": variables})
        response.raise_for_status()
        payload = response.json()
        if payload.get("errors"):
            raise RuntimeError(f"지그재그 GraphQL 오류: {payload['errors']}")
        return payload.get("data") or {}

    async def get_managed_category_tree(self, *, shop_path: str | None = None) -> dict:
        """상품 등록 화면의 카테고리 트리(4단계, 리프까지)를 그대로 반환한다."""
        data = await self._graphql(
            shop_path or config.ZIGZAG_SHOP_PATH,
            "GetRecentManagedCategoryVersion",
            _CATEGORY_TREE_QUERY,
            {},
        )
        return data.get("getRecentManagedCategoryVersion") or {}

    async def get_upload_presigned_url(self, *, extension: str, shop_path: str | None = None) -> dict:
        """상품 이미지 업로드용 S3 presigned URL 발급 (원본 화면 캡처 기준 extension 예: 'jpeg')."""
        data = await self._graphql(
            shop_path or config.ZIGZAG_SHOP_PATH,
            "GetCatalogUploadPreSignedUrl",
            _PRESIGNED_URL_QUERY,
            {"input": {"extension": extension}},
        )
        return data.get("catalog_upload_pre_signed_url") or {}

    async def upload_image_bytes(self, pre_signed_url: str, content: bytes, *, content_type: str = "image/jpeg") -> None:
        """presigned URL로 이미지 바이트를 S3에 직접 PUT (지그재그 세션과 무관한 별도 호스트)."""
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.put(pre_signed_url, content=content, headers={"Content-Type": content_type})
        response.raise_for_status()

    async def create_catalog_product(self, product_input: dict, *, shop_path: str | None = None) -> str:
        data = await self._graphql(
            shop_path or config.ZIGZAG_SHOP_PATH,
            "CreateCatalogProduct",
            _CREATE_PRODUCT_MUTATION,
            {"productInput": product_input},
        )
        return data.get("createCatalogProduct")

    async def search_all_product_ids(
        self,
        *,
        shop_path: str | None = None,
        sales_status_list: list[str] | None = None,
        page_size: int = 50,
    ) -> list[str]:
        """상품관리 > 상품목록 화면과 동일한 검색 쿼리를 페이지네이션해서 등록된 전체 상품 id를 모은다.

        sales_status_list=None이면 판매상태 필터 없이(=전체) 조회한다 (실제 캡처된
        요청은 화면 필터값인 ["ON_SALE"]을 보냈지만, 필드 자체는 nullable이라 null도 허용됨).
        """
        shop = shop_path or config.ZIGZAG_SHOP_PATH
        base_input = {
            "product_code_list": None,
            "product_name": None,
            "product_id_list": [],
            "external_code_list": None,
            "brand_id_list": None,
            "limit_count": page_size,
            "date_created_gte": None,
            "date_created_lte": None,
            "penalty_status_list": None,
            "sales_status_list": sales_status_list,
            "entry_type_list": None,
            "display_status_list": None,
            "quality_status_list": None,
            "suspend_status_list": None,
            "fulfillment_type_list": None,
            "site_country_list": [
                {"site_id": 1, "country": "KR"},
                {"site_id": 3, "country": "KR"},
            ],
            "shipping_fee_type_list": None,
            "bundle_type_list": None,
            "fast_delivery_type_list": None,
            "order": {"field": "renewed_at", "order": "DESC"},
        }

        async def _fetch_page(skip: int) -> tuple[list[str], int]:
            data = await self._graphql(
                shop,
                "GetSearchedProductPlainList",
                _SEARCHED_PRODUCT_PLAIN_LIST_QUERY,
                {"input": {**base_input, "skip_count": skip}},
            )
            result = data.get("searched_product_plain_list") or {}
            page_ids = [str(item["id"]) for item in (result.get("item_list") or []) if item.get("id")]
            return page_ids, result.get("total_count") or 0

        first_ids, total_count = await _fetch_page(0)
        ids = list(first_ids)

        remaining_skips = list(range(page_size, total_count, page_size))
        if remaining_skips:
            # 페이지 조회는 서로 독립적이므로 동시에 가져온다 (순차 조회 시 응답 지연이 누적됨).
            semaphore = asyncio.Semaphore(5)

            async def _fetch(skip: int) -> list[str]:
                async with semaphore:
                    page_ids, _ = await _fetch_page(skip)
                    return page_ids

            for page_ids in await asyncio.gather(*[_fetch(skip) for skip in remaining_skips]):
                ids.extend(page_ids)

        return ids

    async def get_cached_product_list(self, id_list: list[str], *, shop_path: str | None = None) -> list[dict]:
        """상품 id 목록으로 상세정보(이름 등)를 조회한다 - 전체 목록 조회 쿼리는 없고 id 기반 조회만 가능."""
        if not id_list:
            return []
        data = await self._graphql(
            shop_path or config.ZIGZAG_SHOP_PATH,
            "GetCachedProductListInProductManagement",
            _CACHED_PRODUCT_LIST_QUERY,
            {"input": {"id_list": id_list}},
        )
        result = data.get("cached_product_list") or {}
        return result.get("product_list") or []

    async def get_all_products(
        self,
        *,
        shop_path: str | None = None,
        sales_status_list: list[str] | None = None,
        page_size: int = 50,
        detail_chunk_size: int = 50,
    ) -> list[dict]:
        """지그재그에 등록된 전체 상품의 (id, name, product_code) 목록을 가져온다."""
        shop = shop_path or config.ZIGZAG_SHOP_PATH
        ids = await self.search_all_product_ids(
            shop_path=shop, sales_status_list=sales_status_list, page_size=page_size
        )
        chunks = [ids[i:i + detail_chunk_size] for i in range(0, len(ids), detail_chunk_size)]

        semaphore = asyncio.Semaphore(5)

        async def _fetch(chunk: list[str]) -> list[dict]:
            async with semaphore:
                return await self.get_cached_product_list(chunk, shop_path=shop)

        products: list[dict] = []
        for chunk_products in await asyncio.gather(*[_fetch(c) for c in chunks]):
            products.extend(chunk_products)
        return products

    async def get_excel_upload_presigned_url(
        self, *, extension: str, file_name: str, shop_path: str | None = None
    ) -> dict:
        """엑셀 일괄 등록/수정 업로드용 S3 presigned URL 발급 (상품 이미지 업로드용과는 다른 쿼리)."""
        data = await self._graphql(
            shop_path or config.ZIGZAG_SHOP_PATH,
            "GetExcelUploadPreSignedUrl",
            _EXCEL_UPLOAD_PRESIGNED_URL_QUERY,
            {"input": {"extension": extension, "file_name": file_name}},
        )
        return data.get("excel_upload_pre_signed_url") or {}

    async def upload_excel_bytes(self, pre_signed_url: str, content: bytes) -> None:
        """presigned URL로 엑셀 바이트를 S3에 직접 PUT (지그재그 세션과 무관한 별도 호스트)."""
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.put(
                pre_signed_url, content=content,
                headers={"Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
            )
        response.raise_for_status()

    async def send_excel_import_file(
        self,
        *,
        import_type: str,
        key: str,
        origin_file_name: str,
        s3_file_name: str,
        shop_path: str | None = None,
    ) -> str:
        """S3 업로드가 끝난 엑셀 파일을 지그재그에 등록해 임포트 작업 id를 발급받는다."""
        data = await self._graphql(
            shop_path or config.ZIGZAG_SHOP_PATH,
            "SendExcelImportFile",
            _SEND_EXCEL_IMPORT_FILE_MUTATION,
            {
                "input": {
                    "excel": {"import_type": import_type},
                    "file": {"key": key, "origin_file_name": origin_file_name, "s3_file_name": s3_file_name},
                }
            },
        )
        return data.get("sendExcelImportFile")

    async def update_product_price_by_file(self, import_id: str, *, shop_path: str | None = None) -> bool:
        """임포트 작업 id로 '판매가 수정(상품단위)' 엑셀 반영을 실행한다."""
        data = await self._graphql(
            shop_path or config.ZIGZAG_SHOP_PATH,
            "UpdateProductPriceByFile",
            _UPDATE_PRODUCT_PRICE_BY_FILE_MUTATION,
            {"id": import_id},
        )
        return bool(data.get("updateProductPriceByFile"))

    async def get_excel_import_file_list(
        self,
        *,
        import_type_list: list[str] | None = None,
        status_list: list[str] | None = None,
        shop_path: str | None = None,
    ) -> list[dict]:
        data = await self._graphql(
            shop_path or config.ZIGZAG_SHOP_PATH,
            "GetExcelImportFileList",
            _EXCEL_IMPORT_FILE_LIST_QUERY,
            {
                "input": {
                    "import_type_list": import_type_list or ["PRODUCT_PRICE"],
                    "status_list": status_list or ["COMPLETED", "FAIL"],
                }
            },
        )
        result = data.get("excel_import_file_list") or {}
        return result.get("item_list") or []

    async def wait_for_excel_import_result(
        self,
        import_id: str,
        *,
        import_type: str = "PRODUCT_PRICE",
        timeout: float = 30.0,
        poll_interval: float = 2.0,
        shop_path: str | None = None,
    ) -> dict | None:
        """엑셀 임포트 결과(COMPLETED/FAIL)가 목록에 뜰 때까지 폴링한다.

        GetExcelImportFileList는 status_list 필터로 COMPLETED/FAIL만 돌려주고 처리중인 건은
        아예 목록에 없으므로, 우리 import_id가 나타날 때까지 반복 조회하는 방식으로 완료를 기다린다.
        타임아웃 시 None (아직 처리중일 수 있음 - 실패로 간주하면 안 됨)."""
        elapsed = 0.0
        while True:
            items = await self.get_excel_import_file_list(import_type_list=[import_type], shop_path=shop_path)
            for item in items:
                if item.get("id") == import_id:
                    return item
            if elapsed >= timeout:
                return None
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

    async def update_product_price_by_excel(
        self,
        content: bytes,
        *,
        file_name: str,
        shop_path: str | None = None,
        wait: bool = True,
    ) -> dict:
        """'판매가 수정(상품단위)' 엑셀 업로드 3단계(presigned url 발급 → S3 업로드 → 임포트 등록 → 실행 트리거)를
        한 번에 수행하고, wait=True면 처리 결과(COMPLETED/FAIL)가 뜰 때까지 폴링한다."""
        shop = shop_path or config.ZIGZAG_SHOP_PATH
        presigned = await self.get_excel_upload_presigned_url(extension="xlsx", file_name=file_name, shop_path=shop)
        await self.upload_excel_bytes(presigned["pre_signed_url"], content)

        import_id = await self.send_excel_import_file(
            import_type="PRODUCT_PRICE",
            key=presigned["key"],
            origin_file_name=presigned["origin_file_name"],
            s3_file_name=presigned["s3_file_name"],
            shop_path=shop,
        )
        await self.update_product_price_by_file(import_id, shop_path=shop)

        result = None
        if wait:
            result = await self.wait_for_excel_import_result(import_id, shop_path=shop)
        return {"import_id": import_id, "result": result}

    async def find_return_claim_by_phone(
        self,
        phone: str,
        *,
        shop_path: str | None = None,
        status_list: list[str] | None = None,
        date_requested_ymd_gte: int | None = None,
        date_requested_ymd_lte: int | None = None,
        max_pages: int = 10,
        items_per_page: int = 100,
    ) -> dict | None:
        """전화번호로 반품 클레임 목록(item_list)을 뒤져 일치하는 클레임을 찾는다.

        검색창(search_param) 필드 구조가 캡처로 확인되지 않아, 목록을
        페이지네이션하며 order_item.receiver.mobile_tel /
        order_item.order.orderer.mobile_tel을 직접 비교하는 방식으로 매칭한다.
        status_list 기본값은 실제 캡처된 화면(반품수거중)의 값만 사용한다 -
        다른 상태 탭도 포함하려면 해당 화면의 요청을 캡처해 상태값을 확인해야 함.
        """
        target = _normalize_phone(phone)
        if not target:
            return None

        page = 1
        while page <= max_pages:
            data = await self._graphql(
                shop_path or config.ZIGZAG_SHOP_PATH,
                "GetPartnerReturnClaimList",
                _RETURN_CLAIM_QUERY,
                {
                    "request_status_list": status_list or ["RETURN_COLLECTING"],
                    "is_deferred": False,
                    "order_item_number_list": None,
                    "due_date_ymd_complete_lte": None,
                    "due_date_ymd_mark_return_collecting_lte": None,
                    "date_requested_ymd_gte": date_requested_ymd_gte,
                    "date_requested_ymd_lte": date_requested_ymd_lte,
                    "date_completed_ymd_gte": None,
                    "date_completed_ymd_lte": None,
                    "date_marked_return_collected_ymd_gte": None,
                    "date_marked_return_collected_ymd_lte": None,
                    "date_awaiting_additional_payment_gte": None,
                    "date_awaiting_additional_payment_lte": None,
                    "page": page,
                    "items_per_page": items_per_page,
                    "order_by": "DATE_REQUESTED_DESC",
                    "order_search_param": {},
                    "order_item_search_param": {},
                    "order_item_parent_shop_search_param": None,
                    "next_status_after_additional_payment_list": None,
                    "is_awaiting_additional_payment": False,
                },
            )
            claim_list = data.get("partner_claim_list") or {}
            item_list = claim_list.get("item_list") or []
            for claim in item_list:
                order_item = claim.get("order_item") or {}
                receiver_phone = _normalize_phone((order_item.get("receiver") or {}).get("mobile_tel"))
                orderer_phone = _normalize_phone(((order_item.get("order") or {}).get("orderer") or {}).get("mobile_tel"))
                if target in (receiver_phone, orderer_phone):
                    return claim

            total_count = claim_list.get("total_count") or 0
            if page * items_per_page >= total_count or not item_list:
                break
            page += 1

        return None
