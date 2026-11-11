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

## Chế độ Backlog

Bấm **Backlog** rồi quét: tra mã trong sheet `back_log`, cột **"Còn lại (ngày), âm là quá hạn"**, và đọc to `<giá trị> ngày` (vd "1 ngày", "-2 ngày").

| Trường hợp | Màn hình | Giọng đọc |
|---|---|---|
| Còn hạn (≥ 0) | xanh, "Còn hạn" | "1 ngày" |
| Quá hạn (< 0) | đỏ, "Quá hạn" | "-2 ngày" |
| Ô số ngày trống | cam | "Chưa có số ngày còn lại" |
| Mã không có trong `back_log` | đỏ | "Không có trong backlog" |

`back_log` được tải cùng dữ liệu chia chọn (bấm **Tải lại** sau khi sửa sheet). Cột được tìm theo đúng tên tiêu đề — đổi tên cột thì thanh trạng thái báo "backlog lỗi", các chế độ khác vẫn chạy.

## Chế độ Tuyến (chia tuyến theo phường/xã)

Bấm **Tuyến** rồi quét: lấy phường/xã trong địa chỉ (cột `dropoff` của `raw_data`), tra sheet `config_tuyen` và đọc to `<tuyến>, <phường/xã>` (vd "Tuyến 3, Xã Đại Đồng").

**Tạo cấu hình tuyến** — mở project Apps Script (`clasp open-script`), chọn hàm rồi bấm **Run**:

| Hàm | Khi nào | Làm gì |
|---|---|---|
| `taoCauHinhTuyen` | Lần đầu | Lấy toạ độ từng phường/xã (Google Maps, chỉ gửi tên xã/huyện), gom các xã gần nhau thành Tuyến 1, 2, … (mỗi tuyến = một chuyến xe) ghi vào `config_tuyen`. Không chạy nếu sheet đã có dữ liệu. |
| `boSungTuyen` | Khi có xã mới | Chỉ thêm xã chưa có: vào tuyến gần nhất còn chỗ, nếu không thì mở tuyến mới. Không sửa dòng cũ. |

Giới hạn chỉnh trong sheet `cai_dat_tuyen` (tự tạo lần chạy đầu):

| ten | Mặc định | Ý nghĩa |
|---|---|---|
| `so_don_toi_thieu_moi_tuyen` | 30 | Một chuyến xe có ít nhất số đơn này (đếm theo `raw_data` lúc chạy) |
| `so_don_toi_da_moi_tuyen` | 45 | Một chuyến xe có nhiều nhất số đơn này (sức chở) |

Cách gom: mỗi tuyến bắt đầu từ xã ngoài cùng, lần lượt lấy xã gần nhất cho tới khi đủ số đơn tối thiểu (không vượt tối đa). Tuyến còn thiếu đơn ở cuối được tách ra, từng xã nhập vào tuyến gần nhất còn chỗ. Không giới hạn khoảng cách — vùng ngoại thành thưa đơn sẽ có tuyến dài hơn. Tuyến nào vẫn dưới tối thiểu (không còn tuyến gần còn chỗ) được liệt kê trong Execution log. Xã bị Google Maps trả toạ độ cách trung tâm huyện của nó > 15 km (trùng tên xã ở huyện khác) dùng toạ độ trung tâm huyện.

`config_tuyen` (`ten_tuyen, phuong_xa, quan_huyen, lat, lng, so_don`) sửa tay được — đổi `ten_tuyen` để chuyển xã sang tuyến khác. Xã không tìm được toạ độ được ghi với `ten_tuyen` trống để điền tay. Muốn tạo lại từ đầu: xoá sheet `config_tuyen` rồi chạy `taoCauHinhTuyen`.

| Trường hợp | Giọng đọc |
|---|---|
| Có tuyến | "Tuyến 3, Xã Đại Đồng" |
| Xã chưa có trong `config_tuyen` | "Chưa có tuyến, Xã …" → chạy `boSungTuyen` |
| Địa chỉ không có phường/xã | "Chưa rõ phường xã" |
| Đơn huỷ / không có | "Đơn đã huỷ" / "Không tìm thấy đơn" |

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
  routes.js           taoCauHinhTuyen / boSungTuyen: gom phường/xã thành tuyến (config_tuyen)
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
