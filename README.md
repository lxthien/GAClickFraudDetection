# GA Click Fraud Detection

Phát hiện và chặn click ảo cho Google Ads, chạy trên Cloudflare Workers (không cần server), hỗ trợ nhiều website, mỗi website một tài khoản Google Ads và lịch chạy riêng.

**Trạng thái: giai đoạn 0 — xây dựng và kiểm thử.** Mặc định mọi site ở chế độ `log` (chỉ ghi log, không chặn ai).

## Cách hoạt động

```
Google Ads click ──► Landing page (script < 3 KB qua GTM) ──► Worker /c ──► D1
                                                                         │
            Google Ads API ◄── đồng bộ IP loại trừ ◄── cron 5 phút: chấm điểm 0–100
            (chế độ auto)                                  │
                                    Telegram cảnh báo ◄────┴──► API quản trị / dashboard
```

1. **Script theo dõi** (`src/tracker`) chỉ chạy với lượt có `gclid`/`gbraid`/`wbraid`. Thu dấu vân tay nhẹ, thời gian hiển thị, độ cuộn, số lần chạm, click nút gọi/Zalo/Messenger, gửi form. Gửi bằng `sendBeacon`, không chặn hiển thị.
2. **Worker** (`src/worker/collect.ts`) nhận beacon, kiểm tra domain, lấy IP từ kết nối (không bao giờ từ dữ liệu gửi lên), ghi D1.
3. **Cron 5 phút** (`src/worker/cron.ts`) chấm điểm theo 5 lớp tín hiệu, mỗi điểm có mã lý do; gắn cờ hoặc chặn tùy chế độ; đồng bộ Google Ads; hết hạn lệnh chặn. Mỗi ngày lúc 3 giờ sáng: xóa log quá 90 ngày, nhập `click_view` để đối soát.

## Chế độ của từng site

| Chế độ | Ghi log | Chấm điểm | Gắn cờ IP | Đẩy lên Google Ads |
| --- | --- | --- | --- | --- |
| `off` | | | | |
| `log` | ✓ | ✓ | | |
| `suggest` | ✓ | ✓ | ✓ (bạn duyệt, dán tay) | |
| `auto` | ✓ | ✓ | ✓ | ✓ mỗi 5 phút |

Site tự "ngủ" (không ghi gì) khi ngoài `schedule` hoặc khi mọi chiến dịch Search tạm dừng (`follow_campaigns`). Khi quảng cáo chạy lại, site quay về chỉ ghi log trong `resume_warmup_hours` (mặc định 72) trước khi chặn.

## Quy tắc chấm điểm (điểm khởi đầu, sẽ chỉnh theo dữ liệu thật)

| Mã | Điểm | Ý nghĩa |
| --- | --- | --- |
| `AUTOMATION` | +70 | Trình duyệt tự động (webdriver, headless) |
| `NET_DATACENTER` | +60 | IP máy chủ / hosting |
| `REPEAT_CLICKS` | +40 | Cùng thiết bị click quảng cáo ≥ 3 lần / 24 giờ |
| `NET_VPN` | +30 | VPN thương mại, Cloudflare WARP |
| `DEVICE_MULTI_IP` | +30 | Một thiết bị dùng ≥ 3 IP / 24 giờ |
| `BOUNCE` | +25 | Hiển thị < 3 giây, không cuộn, không chạm |
| `OUT_OF_AREA` | +20 | Ngoài quốc gia nhắm mục tiêu |
| `NO_END_SIGNAL` | +10 | Không có dữ liệu kết thúc sau 30 phút |
| `NET_RELAY` | +5 | iCloud Private Relay |
| `LEAD_FAKE` | +80 | Sale đánh dấu lead giả / đối thủ |
| `EXEMPT_CONVERSION` | miễn | Đã chuyển đổi hợp lệ hoặc lead thật |

Ngưỡng mặc định: dưới 40 bình thường, 40–69 theo dõi, từ 70 chặn (chỉnh riêng từng site).

## Bảo vệ khách thật

- Đã gọi / nhắn Zalo / gửi form hợp lệ → thiết bị vào whitelist vĩnh viễn, IP 30 ngày, lệnh chặn cũ trên IP đó bị gỡ.
- **Nhà mạng VN** (Viettel, VNPT, Mobifone, FPT…): không chặn chỉ vì đếm click, vị trí hay thoát trang; cần bằng chứng ở mức thiết bị. Chặn 48 giờ, không bao giờ chặn cả dải.
- **iCloud Private Relay**: không bao giờ chặn theo IP (hàng nghìn người dùng iPhone chung IP).
- **Datacenter**: chặn cả dải /24 (IPv6 /48), cố định.
- IPv6 được nhận diện theo tiền tố /64.
- "Cùng thiết bị" = cùng `visitor_id`, hoặc cùng dấu vân tay **và** cùng IP (dấu vân tay nhẹ trùng nhau nhiều giữa các iPhone cùng đời).
- IP bạn tự thêm trong Google Ads được giữ nguyên, không bị hệ thống gỡ.

## 500 ô IP mỗi chiến dịch

90 ô cố định (datacenter, đối thủ) · tối đa 400 ô xoay vòng theo điểm × độ mới (chu kỳ bán rã 24 giờ) · 10 ô dự phòng luôn chừa cho IP mới trong 1 giờ.

## Cài đặt

Yêu cầu: Node 20+, tài khoản Cloudflare (gói miễn phí đủ cho giai đoạn 0).

```bash
npm install
npx wrangler login
npx wrangler d1 create gcf                 # dán database_id vào wrangler.toml
npm run db:migrate:remote
npx wrangler secret put ADMIN_TOKEN        # chuỗi ngẫu nhiên dài
npm run deploy
```

Thêm một site (mỗi domain hoặc nhóm domain của một công ty):

```bash
curl -X PUT https://gcf-worker.<tài-khoản>.workers.dev/admin/sites/kim-anh \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "Kim Anh",
    "site_key": "kimanh_<chuỗi ngẫu nhiên>",
    "domains": ["kientruckimanh.com", "xaydungkimanh.com"],
    "ads_customer_id": "123-456-7890",
    "mode": "log",
    "share_group": "kim-anh",
    "telegram_chat_id": "-100..."
  }'
```

Gắn tag GTM: xem [docs/gtm-setup.md](docs/gtm-setup.md).

### Kết nối Google Ads API (khi cần đối soát `click_view` hoặc chế độ `auto`)

Từ 09/09/2026 Google bỏ developer token; không cần tài khoản MCC.

1. Tạo Google Cloud project (không để ở gói dùng thử miễn phí), bật Google Ads API, xin quyền **Explorer** tại trang Google Ads API Overview.
2. Tạo OAuth client, lấy refresh token cho một email Google được cấp quyền trong **từng** tài khoản Google Ads.
3. Đặt secrets: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`.

Hệ thống gọi API theo ID của từng tài khoản. Phiên bản API đặt ở `GOOGLE_ADS_API_VERSION` trong `wrangler.toml`.

## API quản trị

Mọi endpoint cần `Authorization: Bearer <ADMIN_TOKEN>`.

| Phương thức | Đường dẫn | Việc |
| --- | --- | --- |
| GET | `/admin/sites` | Danh sách site |
| PUT | `/admin/sites/:id` | Tạo / sửa site |
| GET | `/admin/sites/:id/summary?days=7` | Lượt theo kết luận, lý do hay gặp, click tính tiền mà không vào trang |
| GET | `/admin/sites/:id/visits?verdict=block` | Chi tiết từng lượt |
| GET | `/admin/sites/:id/blocks?status=suggested` | IP đang gắn cờ / chặn |
| GET | `/admin/sites/:id/blocks/export` | IP gợi ý, mỗi dòng một IP, dán vào Google Ads |
| POST | `/admin/sites/:id/blocks/remove` | Gỡ chặn tay, tùy chọn đưa vào whitelist |
| POST | `/admin/whitelist` | Thêm IP/CIDR hoặc thiết bị vào whitelist |
| POST | `/admin/leads` | Trạng thái lead từ Google Sheet |
| GET | `/admin/sites/:id/refund-report?from=&to=` | CSV hồ sơ xin hoàn tiền |

## Phát triển

```bash
npm test                    # build script + 43 kiểm thử (D1 giả lập bằng SQLite, chạy migration thật)
npm run typecheck
npm run db:migrate:local && npm run dev   # chạy cục bộ; .dev.vars: ADMIN_TOKEN=..., DEV=1
```

`DEV=1` cho phép giả lập IP bằng header `X-Forwarded-For`. Không đặt biến này khi deploy.

## Giới hạn đã biết

- Click đầu tiên của kẻ gian vẫn bị tính tiền; chỉ chặn được từ lần sau.
- Performance Max, video, app không có loại trừ IP.
- Không có danh sách đen dùng chung toàn cầu như các tool thương mại.
- Gói miễn phí Workers: 10 ms CPU, 50 lệnh gọi ra ngoài mỗi lần chạy; khi tự chặn cho nhiều tài khoản có thể cần gói Workers Paid.
