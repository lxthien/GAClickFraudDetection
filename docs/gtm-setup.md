# Gắn script theo dõi qua Google Tag Manager

Mỗi website dùng `site_key` riêng (đã khai báo qua `PUT /admin/sites/:id`).

## 1. Biến

**Variables → New → 1st Party Cookie**, tên `Cookie - gcf_ad`, cookie name `_gcf_ad`.

## 2. Trigger "Lượt quảng cáo"

**Triggers → New → Window Loaded → Some Window Loaded Events**:

- `Page URL` matches RegEx `[?&](gclid|gbraid|wbraid)=`

Thêm trigger thứ hai cùng loại với điều kiện `Cookie - gcf_ad` equals `1` (để các trang sau trong cùng lượt quảng cáo vẫn đo được bấm gọi / gửi form). Lượt từ SEO không thỏa điều kiện nào nên không tải script.

## 3. Tag

**Tags → New → Custom HTML**, gắn cả hai trigger ở trên:

```html
<script async src="https://gcf-worker.<tài-khoản>.workers.dev/t.js?s=SITE_KEY"></script>
```

## 4. (Giai đoạn 4) Chỉ bắn chuyển đổi cho lượt sạch

Script đẩy sự kiện vào `dataLayer` mỗi khi khách bấm gọi / Zalo / Messenger hoặc gửi form:

| Sự kiện | Khi nào | Biến |
| --- | --- | --- |
| `gcf_conv_ok` | Lượt sạch | `gcf_type` = `call` \| `zalo` \| `mess` \| `form` |
| `gcf_conv_blocked` | Bị bộ lọc chặn | `gcf_type`, `gcf_reason` = `automation` \| `too_fast` \| `honeypot` \| `phone_format` |

Đổi trigger của các tag chuyển đổi Google Ads từ "Click URL contains tel:" sang **Custom Event `gcf_conv_ok`** (lọc theo `gcf_type`). Bot và lead giả sẽ không còn làm sai dữ liệu Smart Bidding.

Bộ lọc form:

- Thêm vào form một trường ẩn bẫy bot: `<input name="_hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px">`. Người thật không điền, bot thường điền.
- Ô số điện thoại (`type=tel` hoặc `name` chứa `phone`/`sdt`/`dien`) phải là số di động VN 10 số.
- Trang phải hiển thị ít nhất 4 giây trước khi gửi (2 giây với nút gọi / Zalo).

## 5. Kiểm tra tốc độ trang

Chạy PageSpeed Insights trên 3 landing page chính **trước** khi bật tag và **1 tuần sau**. Nếu chỉ số xấu đi, tạm dừng tag trong GTM là gỡ được ngay.
