# Chia chọn đơn hàng (Ahamove)

Công cụ chia chọn đơn: quét mã vận đơn → tra quận/huyện trong Google Sheet → đọc to vị trí kệ bằng giọng nói.

**Mở công cụ:** https://dtnam-oss.github.io/ahamove/

- Giao diện: trang tĩnh trên GitHub Pages (`web/`).
- Backend: Google Apps Script web app (`gas/`): `GET ?action=data` trả JSON tối giản; `GET ?action=trips` / `POST {action:'trip'}` đọc/lưu chuyến đi ở sheet `chuyen_di`.

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

## Chế độ Chuyến đi

Thay cho chế độ Ghi sheet cũ (sheet `data_don` giữ nguyên, không còn được ghi).

**Tạo chuyến:** bấm **Chuyến đi** → **+ Tạo chuyến đi** → nhập **BKS** (4–15 ký tự: chữ, số, `-`, `.`, khoảng trắng) → quét từng đơn xếp lên xe → **Kết thúc chuyến**.

| Khi quét | Giọng đọc | Vào chuyến? |
|---|---|---|
| Đơn có trong `raw_data`, trạng thái khác `NEED_RETURN_TO_PARTNER_EOD` | "Có" | có |
| Trạng thái `NEED_RETURN_TO_PARTNER_EOD` | "Không, đơn trả đối tác" | không |
| Đã quét trong chuyến này | "Đã quét" | không |
| Đã nằm trong chuyến khác hôm nay (mọi máy) | "Đã ở chuyến xe `<BKS>`" | không |
| Mã không có trong `raw_data` | "Không tìm thấy đơn" | không |

- Mỗi lần quét được kiểm tra ngay trên máy (dữ liệu đã tải + danh sách chuyến hôm nay), không chờ mạng. Danh sách trạng thái bị từ chối: `TRIP_REFUSED_STATUSES` trong `web/lookup.js`.
- Chuyến đang quét được lưu trên máy (tải lại trang không mất). Chỉ khi bấm **Kết thúc** mới gửi cả chuyến lên một lần; lỗi mạng thì chuyến vẫn giữ, bấm Kết thúc lại.
- Khi lưu, server kiểm tra lại: đơn đã được máy khác đưa vào chuyến hôm nay thì cả chuyến chưa được lưu, các đơn đó bị bỏ khỏi chuyến và màn hình báo "Đã bỏ N đơn" → bấm Kết thúc lại.
- Sheet `chuyen_di` (tự tạo ở lần lưu đầu): mỗi đơn một dòng `ma_chuyen | bks | thoi_gian | tracking_number`, dạng text. Mã chuyến `CD<yyMMdd>-<số thứ tự trong ngày>`, vd `CD261113-01`; giờ Việt Nam.

**Danh sách chuyến:** ở màn hình Chuyến đi, chọn ngày (mặc định hôm nay) → các chuyến mới nhất trước, của mọi máy. Bấm **Xem đơn** để hiện danh sách mã (mỗi đơn một dòng) và **Copy** để dán sang ứng dụng khác. Điện thoại hiện dạng thẻ, màn hình rộng (≥ 640px) hiện dạng bảng.

Ai có URL API đều xem và tạo được chuyến (giống các chế độ khác: chỉ có mã vận đơn và BKS, không có thông tin khách).

## Chế độ Backlog

Bấm **Backlog** rồi quét: tra mã trong sheet `back_log`, cột **"Còn lại (ngày), âm là quá hạn"**, và đọc to `<giá trị> ngày` (vd "1 ngày", "-2 ngày").

| Trường hợp | Màn hình | Giọng đọc |
|---|---|---|
| Còn hạn (≥ 0) | xanh, "Còn hạn" | "1 ngày" |
| Quá hạn (< 0) | đỏ, "Quá hạn" | "-2 ngày" |
| Ô số ngày trống | cam | "Chưa có số ngày còn lại" |
| Mã không có trong `back_log` | đỏ | "Không có trong backlog" |

`back_log` được tải cùng dữ liệu chia chọn (bấm **Tải lại** sau khi sửa sheet). Cột được tìm theo đúng tên tiêu đề — đổi tên cột thì thanh trạng thái báo "backlog lỗi", các chế độ khác vẫn chạy.

## Chế độ Chia tuyến

Giống **Chia chọn** nhưng dùng tuyến thay cho khu vực: quét đơn → đọc to tuyến của đơn (vd "Tuyến 3"), màn hình hiện thêm phường/xã · quận/huyện. Tuyến lấy theo phường/xã trong địa chỉ, tra sheet `config_tuyen` (xem mục dưới).

| Trường hợp | Giọng đọc |
|---|---|
| Có tuyến | "Tuyến 3" |
| Xã của đơn chưa có trong `config_tuyen` | "Chưa có tuyến" → chạy `boSungTuyen` hoặc điền tay |
| Địa chỉ không có phường/xã | "Chưa rõ phường xã" |
| Đơn huỷ / không có | "Đơn đã huỷ" / "Không tìm thấy đơn" |

## Chế độ Tuyến (chia tuyến theo phường/xã)

Bấm **Tuyến** để kiểm hàng lên xe theo tuyến:

1. **Chọn tuyến:** danh sách tuyến kèm số đơn hôm nay (đơn trong `raw_data`, không tính đơn huỷ) và các quận/huyện; bấm vào quận để xem từng phường/xã. Tick các tuyến cần xuất → **Bắt đầu quét**.
2. **Quét:** bộ đếm `đã quét/tổng` của các tuyến đã chọn. Đơn được xếp vào tuyến theo phường/xã trong địa chỉ (cột `dropoff`) tra trong sheet `config_tuyen`.

| Trường hợp | Màn hình | Giọng đọc |
|---|---|---|
| Đơn thuộc tuyến đã chọn | xanh, tăng bộ đếm | "Có" (đơn cuối: "Có, đủ đơn") |
| Đơn đã quét rồi | cam | "Đã quét" |
| Đơn thuộc tuyến khác | đỏ | "Không, Tuyến 5" |
| Xã của đơn chưa có tuyến | đỏ | "Không, đơn chưa có tuyến" → chạy `boSungTuyen` |
| Đơn huỷ / không có | đỏ | "Đơn đã huỷ" / "Không tìm thấy đơn" |

Tiến độ lưu trên máy đang quét (tải lại trang vẫn còn, tự xoá khi sang ngày mới). **Đổi tuyến** quay lại danh sách; **Làm lại** xoá tiến độ của các tuyến đang chọn.

**Tạo cấu hình tuyến** — mở project Apps Script (`clasp open-script`), chọn hàm rồi bấm **Run**:

| Hàm | Khi nào | Làm gì |
|---|---|---|
| `taoCauHinhTuyen` | Lần đầu | Lấy toạ độ từng phường/xã bằng Goong (từ địa chỉ của tối đa 3 đơn trong xã), gom các xã gần nhau thành Tuyến 1, 2, … (mỗi tuyến = một chuyến xe) ghi vào `config_tuyen`. Không chạy nếu sheet đã có dữ liệu. |
| `boSungTuyen` | Khi có xã mới | Chỉ thêm xã chưa có: vào tuyến gần nhất còn chỗ, nếu không thì mở tuyến mới. Không sửa dòng cũ. |

Giới hạn chỉnh trong sheet `cai_dat_tuyen` (tự tạo lần chạy đầu):

| ten | Mặc định | Ý nghĩa |
|---|---|---|
| `so_don_toi_thieu_moi_tuyen` | 30 | Một chuyến xe có ít nhất số đơn này (đếm theo `raw_data` lúc chạy) |
| `so_don_toi_da_moi_tuyen` | 45 | Một chuyến xe có nhiều nhất số đơn này (sức chở) |

Cách gom: mỗi tuyến bắt đầu từ xã ngoài cùng, lần lượt lấy xã gần nhất cho tới khi đủ số đơn tối thiểu (không vượt tối đa). Tuyến còn thiếu đơn ở cuối được tách ra, từng xã nhập vào tuyến gần nhất còn chỗ. Không giới hạn khoảng cách — vùng ngoại thành thưa đơn sẽ có tuyến dài hơn. Tuyến nào vẫn dưới tối thiểu (không còn tuyến gần còn chỗ) được liệt kê trong Execution log. Kết quả Goong chỉ được dùng khi nằm đúng quận/huyện của đơn; xã không định vị được ghi với `ten_tuyen` trống để điền tay.

`config_tuyen` (`ten_tuyen, phuong_xa, quan_huyen, lat, lng, so_don`) sửa tay được — đổi `ten_tuyen` để chuyển xã sang tuyến khác. Xã không tìm được toạ độ được ghi với `ten_tuyen` trống để điền tay. Muốn tạo lại từ đầu: xoá sheet `config_tuyen` rồi chạy `taoCauHinhTuyen`.

**Bản đồ (Goong):** ở màn hình quét: 🔵 các phường/xã của tuyến đã chọn, 🟢 thêm một điểm cho mỗi đơn quét được. Vị trí đơn lấy bằng cách gửi địa chỉ đơn sang Goong (chỉ khi quét, mỗi đơn một lần), lưu cache ở sheet `toa_do_don` (xoá dòng để định vị lại). Nếu Goong không đặt được địa chỉ vào đúng quận/huyện thì dùng điểm của phường/xã. API chỉ trả toạ độ của đơn vừa quét, không trả danh sách.

Key Goong: REST API key ở `gas/config.js` (`GOONG_API_KEY`, không đưa lên git); Maptiles key ở `web/config.js` (`goongMaptilesKey`, công khai — nên giới hạn tên miền trong trang quản trị Goong). Gói miễn phí Maptiles ~1.000 lượt tải bản đồ/tháng; bản đồ chỉ tải khi quét ở chế độ Tuyến.

## Cấu trúc

```
web/                  giao diện (GitHub Pages, deploy tự động khi push main)
  index.html, style.css
  config.js           URL API Apps Script (/exec)
  lookup.js           logic tra cứu phía client (được test bằng Node)
  order-map.js        bản đồ Goong ở chế độ Tuyến: điểm xã + đơn đã quét (tải thư viện khi cần)
  app.js              điều khiển: tải dữ liệu, nhập liệu, camera, giọng nói
gas/                  backend Apps Script
  appsscript.json     manifest (chạy bằng quyền người deploy, truy cập ẩn danh)
  Code.js             doGet: ?action=data → JSON; không tham số → link sang giao diện
                      doPost {action:'trip'}: lưu chuyến đi (trips.js)
  routes.js           taoCauHinhTuyen / boSungTuyen: gom phường/xã thành tuyến (config_tuyen)
  goong.js            gọi Goong geocode (kiểm tra đúng quận/huyện)
  locate.js           ?action=locate&code=: toạ độ một đơn cho bản đồ (cache toa_do_don)
  trips.js            createTrip / listTrips: chuyến đi ở sheet chuyen_di (?action=trips&day=dd/MM/yyyy)
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
