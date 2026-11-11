# Chia chọn đơn hàng (Ahamove)

Công cụ chia chọn đơn: quét mã vận đơn → tra quận/huyện trong Google Sheet → đọc to vị trí kệ bằng giọng nói.

**Mở công cụ:** https://dtnam-oss.github.io/ahamove/

- Giao diện: trang tĩnh trên GitHub Pages (`web/`).
- Backend: Google Apps Script web app (`gas/`): `GET ?action=data` trả JSON tối giản; `POST {action:'write'}` ghi mã vào sheet `data_don`.

Giao diện không chạy bên trong Apps Script vì iframe của Apps Script không cấp quyền `camera`, nên camera trực tiếp bị chặn (`NotAllowedError`).

## Luồng xử lý

1. User quét **Mã vận đơn** (vd `GYEGFF9C`) bằng súng barcode (PC/mobile) hoặc camera điện thoại (QR/barcode).
2. Tra cột `tracking_number` ở sheet `raw_data` (cột được tìm theo tên tiêu đề, thứ tự cột không quan trọng).
3. Nếu cột `status` = `NEED_RETURN_TO_PARTNER_ASAP` → đọc "Đơn đã huỷ" và dừng (danh sách trạng thái huỷ: `CANCELLED_STATUSES` trong `web/lookup.js`).
4. Ngược lại lấy `district`, so với cột `khu_vuc` ở sheet `config` (một ô có thể chứa nhiều quận, phân tách dấu phẩy).
5. Đọc to và hiển thị kết quả:

| Trường hợp | Giọng đọc |
|---|---|
| Đơn đã huỷ | "Đơn đã huỷ" |
| Có vị trí | `<ten_vi_tri>, <district>` — vd "Khu vực 2, Huyện Thanh Trì" |
| Quận chưa có trong config | "Chưa có vị trí, `<district>`" |
| Đơn không có quận | "Đơn chưa có quận huyện" |
| Mã không tồn tại | "Không tìm thấy đơn" |

Dữ liệu được tải về trình duyệt một lần (chỉ mã → quận + trạng thái, và config; không có tên/SĐT/địa chỉ), nên mỗi lần quét trả kết quả tức thì. Bấm **Tải lại** sau khi sửa sheet.

## Cách dùng

- Bấm **Bắt đầu ca** (bắt buộc để bật giọng nói trên iPhone).
- **Súng barcode:** ô nhập luôn giữ focus; súng gõ mã + Enter.
- **Camera:** bấm 📷. Nếu trình duyệt chặn camera trực tiếp, dùng nút **Chụp ảnh mã vận đơn**.
- So khớp không phân biệt hoa/thường, khoảng trắng, dấu tiếng Việt (`Hòa` = `Hoà`). Nếu QR chứa URL/chuỗi dài, mã vận đơn bên trong vẫn được nhận.

## Chế độ Ghi sheet

Bấm **Ghi sheet**, nhập **Cột nhập** của bạn (bắt buộc, vd `C`) và **Từ dòng** (không bắt buộc, mặc định 1), rồi quét như bình thường. Chưa nhập cột thì không quét được ("Chưa nhập cột").

- Mỗi lần quét ghi **mã vận đơn** vào cột đó của sheet `data_don` (dạng text), lần sau ghi xuống dòng kế tiếp. Đọc to "Đã ghi ô C3".
- Ô đã có dữ liệu thì tự nhảy xuống ô trống kế tiếp — không bao giờ ghi đè; nhiều người ghi chung một cột vẫn an toàn.
- **Trùng mã:** nếu mã đã có ở bất kỳ ô nào trong cột đó → đọc "Trùng mã", không ghi, màn hình hiện ô đang chứa mã.
- Chỉ nhận mã gồm chữ/số và `. _ -` (chặn chèn công thức). Ai có URL API đều ghi được vào `data_don`.

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
                      doPost: ghi mã vào data_don (writeScan)
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
