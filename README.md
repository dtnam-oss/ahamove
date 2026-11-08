# Chia chọn đơn hàng (Ahamove)

Công cụ chia chọn đơn: quét mã vận đơn → tra quận/huyện trong Google Sheet → đọc to vị trí kệ bằng giọng nói.

**Mở công cụ:** https://dtnam-oss.github.io/ahamove/

- Giao diện: trang tĩnh trên GitHub Pages (`web/`).
- Backend: Google Apps Script web app (`gas/`), `GET ?action=data` trả JSON tối giản.

Giao diện không chạy bên trong Apps Script vì iframe của Apps Script không cấp quyền `camera`, nên camera trực tiếp bị chặn (`NotAllowedError`).

## Luồng xử lý

1. User quét **Mã vận đơn** (vd `GYE7Q9U3`) bằng súng barcode (PC/mobile) hoặc camera điện thoại (QR/barcode).
2. Tra cột `partner_order_code` ở sheet `data` → lấy `district`.
3. So `district` với cột `khu_vuc` ở sheet `config` (một ô có thể chứa nhiều quận, phân tách dấu phẩy).
4. Đọc to và hiển thị kết quả:

| Trường hợp | Giọng đọc |
|---|---|
| Có vị trí | `<ten_vi_tri>, <district>` — vd "Khu vực 2, Huyện Thanh Trì" |
| Quận chưa có trong config | "Chưa có vị trí, `<district>`" |
| Đơn không có quận | "Đơn chưa có quận huyện" |
| Mã không tồn tại | "Không tìm thấy đơn" |

Dữ liệu được tải về trình duyệt một lần (chỉ mã → quận + config, không có tên/SĐT/địa chỉ), nên mỗi lần quét trả kết quả tức thì. Bấm **Tải lại** sau khi sửa sheet.

## Cách dùng

- Bấm **Bắt đầu ca** (bắt buộc để bật giọng nói trên iPhone).
- **Súng barcode:** ô nhập luôn giữ focus; súng gõ mã + Enter.
- **Camera:** bấm 📷. Nếu trình duyệt chặn camera trực tiếp, dùng nút **Chụp ảnh mã vận đơn**.
- So khớp không phân biệt hoa/thường, khoảng trắng, dấu tiếng Việt (`Hòa` = `Hoà`). Nếu QR chứa URL/chuỗi dài, mã vận đơn bên trong vẫn được nhận.

## Cấu trúc

```
web/                  giao diện (GitHub Pages, deploy tự động khi push main)
  index.html, style.css
  config.js           URL API Apps Script (/exec)
  lookup.js           logic tra cứu phía client (được test bằng Node)
  app.js              điều khiển: tải dữ liệu, nhập liệu, camera, giọng nói
gas/                  backend Apps Script
  appsscript.json     manifest (chạy bằng quyền người deploy, truy cập ẩn danh)
  Code.js             doGet: ?action=data → JSON; không tham số → link sang giao diện
  config.example.js   mẫu config — copy thành config.js (git-ignored)
test/lookup.test.js   test logic tra cứu + backend
.github/workflows/pages.yml   test + deploy web/ lên GitHub Pages
```

## Phát triển & triển khai

Yêu cầu: Node ≥ 20, [`clasp`](https://github.com/google/clasp) đã đăng nhập, bật Apps Script API tại https://script.google.com/home/usersettings.

```bash
cp gas/config.example.js gas/config.js   # điền SHEET_ID
npm test                                 # chạy test
clasp push --force                       # đẩy code lên Apps Script
clasp update-deployment <DEPLOYMENT_ID>  # cập nhật backend, giữ nguyên URL
clasp list-deployments                   # xem DEPLOYMENT_ID
```

Giao diện tự deploy khi push lên `main`. Đổi URL backend trong `web/config.js`.

Lần deploy đầu, chủ script phải mở script editor, chạy hàm `getLookupData` một lần và cấp quyền đọc Google Sheets. Sau đó web app mới truy cập ẩn danh được.

Tài khoản deploy cần quyền xem sheet. Sheet có thể để riêng tư: web app đọc bằng quyền người deploy.
