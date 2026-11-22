# pc-typer: nhận mã quét ở tab "Quét QR" trên điện thoại (cùng Wi-Fi) và gõ mã đó vào chỗ con trỏ trên máy
# Windows này, rồi bấm Enter để xuống dòng — giống súng barcode (Excel, Google Sheet, Notepad…).
# Chỉ dùng thành phần có sẵn của Windows 10/11: PowerShell 5.1 + .NET Framework (không cần cài thêm).
#
# Giao thức (HTTPS, cổng 8443, chứng chỉ tự ký tạo ở lần chạy đầu):
#   GET  /?key=<mã>   trang mở trên điện thoại: chấp nhận chứng chỉ rồi chuyển về app kèm địa chỉ + mã kết nối
#   GET  /ping        header X-Key → {"ok":true,"name":"<tên máy>"}
#   POST /type        header X-Key, thân text/plain = mã cần gõ → {"ok":true}
# Mã kết nối (8 ký tự) chỉ hiện trong cửa sổ này: máy khác trong mạng không có mã thì không gõ được gì.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = 'pc-typer'

$Port = 8443
$AppOrigin = 'https://dtnam-oss.github.io'
$AppUrl = 'https://dtnam-oss.github.io/ahamove/'

# ---------- Mã kết nối: tạo một lần, lưu trong %LOCALAPPDATA%\pc-typer ----------
$StateDir = Join-Path $env:LOCALAPPDATA 'pc-typer'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$KeyFile = Join-Path $StateDir 'key.txt'
$Key = ''
if (Test-Path $KeyFile) { $Key = (Get-Content -Path $KeyFile -Raw).Trim() }
if ($Key -notmatch '^[A-Z2-9]{8}$') {
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' # bỏ I, O, 0, 1 cho dễ đọc
  $bytes = New-Object byte[] 8
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $Key = -join ($bytes | ForEach-Object { $alphabet[$_ % 32] })
  Set-Content -Path $KeyFile -Value $Key -Encoding ASCII
}

# ---------- Chứng chỉ HTTPS tự ký trong kho của người dùng hiện tại, tự gia hạn trước khi hết hạn ----------
$Cert = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.FriendlyName -eq 'pc-typer' -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(7) } |
  Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $Cert) {
  Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.FriendlyName -eq 'pc-typer' } | Remove-Item
  $Cert = New-SelfSignedCertificate -Subject 'CN=pc-typer' -FriendlyName 'pc-typer' `
    -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(397) `
    -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyUsage DigitalSignature, KeyEncipherment `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1')
}

# ---------- Server + gõ phím (C#, biên dịch khi chạy) ----------
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public static class PcTyper {
    public static string Key, Origin, AppUrl, Name;
    public static X509Certificate2 Cert;
    const int MaxText = 200, MaxHead = 8192, MaxBody = 2048;
    static readonly object TypeLock = new object();

    /** Accept connections forever; each one is served on a pool thread (one request, then closed). */
    public static void Run(int port) {
        var listener = new TcpListener(IPAddress.Any, port);
        listener.Start();
        while (true) {
            var client = listener.AcceptTcpClient();
            ThreadPool.QueueUserWorkItem(delegate { Serve(client); });
        }
    }

    static void Serve(TcpClient client) {
        try {
            using (client)
            using (var ssl = new SslStream(client.GetStream(), false)) {
                ssl.ReadTimeout = 10000;
                ssl.WriteTimeout = 10000;
                ssl.AuthenticateAsServer(Cert, false, SslProtocols.Tls12, false);
                Handle(ssl);
            }
        } catch (Exception) {
            // Certificate not accepted yet on the phone, idle pre-connect timing out, client gone: nothing to do.
        }
    }

    static void Handle(Stream s) {
        string head = ReadHead(s);
        if (head == null) return;
        string[] lines = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
        string[] first = lines[0].Split(' ');
        if (first.Length < 2) return;
        string method = first[0], target = first[1], path = target, query = "";
        int q = target.IndexOf('?');
        if (q >= 0) { path = target.Substring(0, q); query = target.Substring(q + 1); }
        var h = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < lines.Length; i++) {
            int c = lines[i].IndexOf(':');
            if (c > 0) h[lines[i].Substring(0, c).Trim()] = lines[i].Substring(c + 1).Trim();
        }
        bool cors = Header(h, "Origin") == Origin;

        if (method == "OPTIONS") {
            Send(s, 204, null, null, cors, cors ? "Access-Control-Allow-Methods: GET, POST\r\n"
                + "Access-Control-Allow-Headers: Content-Type, X-Key\r\n"
                + "Access-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 600\r\n" : null);
            return;
        }
        if (method == "GET" && path == "/") { Root(s, query, Header(h, "Host")); return; }
        if (!SameKey(Header(h, "X-Key"))) { Json(s, 401, "{\"error\":\"Sai mã kết nối\"}", cors); return; }
        if (method == "GET" && path == "/ping") { Json(s, 200, "{\"ok\":true,\"name\":\"" + Escape(Name) + "\"}", cors); return; }
        if (method == "POST" && path == "/type") {
            int len;
            if (!int.TryParse(Header(h, "Content-Length"), out len) || len < 0 || len > MaxBody) {
                Json(s, 400, "{\"error\":\"Mã quá dài\"}", cors);
                return;
            }
            string text = Clean(Encoding.UTF8.GetString(ReadBody(s, len)));
            if (text == null) { Json(s, 400, "{\"error\":\"Mã trống hoặc quá dài\"}", cors); return; }
            TypeLine(text);
            Console.WriteLine(DateTime.Now.ToString("HH:mm:ss") + "  " + text);
            Json(s, 200, "{\"ok\":true}", cors);
            return;
        }
        Json(s, 404, "{\"error\":\"Không có\"}", cors);
    }

    /** The link shown in the window: once the phone trusts the certificate, send it back to the app with the pairing. */
    static void Root(Stream s, string query, string host) {
        string key = null;
        foreach (string part in query.Split('&')) if (part.StartsWith("key=")) key = Uri.UnescapeDataString(part.Substring(4));
        if (SameKey(key) && host != null && Regex.IsMatch(host, @"^[A-Za-z0-9.\-]+:\d{1,5}$")) {
            Send(s, 302, null, null, false, "Location: " + AppUrl + "#pc=" + Uri.EscapeDataString(host) + "&key=" + Key + "\r\n");
            return;
        }
        byte[] page = Encoding.UTF8.GetBytes("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
            + "<p style='font:18px sans-serif;padding:16px'>pc-typer đang chạy. Mở đúng địa chỉ hiện trong cửa sổ pc-typer trên máy tính.</p>");
        Send(s, 200, "text/html; charset=utf-8", page, false, null);
    }

    /** Printable text only (no control characters such as Enter or Tab), 1..200 characters; null otherwise. */
    public static string Clean(string value) {
        if (value == null) return null;
        var sb = new StringBuilder();
        foreach (char ch in value) if (ch >= 0x20 && (ch < 0x7F || ch > 0x9F)) sb.Append(ch);
        string text = sb.ToString().Trim();
        return text.Length == 0 || text.Length > MaxText ? null : text;
    }

    static bool SameKey(string given) {
        if (given == null || given.Length != Key.Length) return false;
        int diff = 0;
        for (int i = 0; i < Key.Length; i++) diff |= given[i] ^ Key[i];
        return diff == 0;
    }

    static string Header(Dictionary<string, string> h, string name) {
        string v;
        return h.TryGetValue(name, out v) ? v : null;
    }

    static string Escape(string v) { return (v ?? "").Replace("\\", "\\\\").Replace("\"", "\\\""); }

    static string ReadHead(Stream s) {
        var buf = new List<byte>();
        while (buf.Count < MaxHead) {
            int b = s.ReadByte();
            if (b < 0) return null;
            buf.Add((byte)b);
            int n = buf.Count;
            if (n >= 4 && buf[n - 4] == 13 && buf[n - 3] == 10 && buf[n - 2] == 13 && buf[n - 1] == 10)
                return Encoding.ASCII.GetString(buf.ToArray(), 0, n - 4);
        }
        return null;
    }

    static byte[] ReadBody(Stream s, int len) {
        var body = new byte[len];
        int got = 0;
        while (got < len) {
            int r = s.Read(body, got, len - got);
            if (r <= 0) break;
            got += r;
        }
        return body;
    }

    static void Json(Stream s, int code, string json, bool cors) {
        Send(s, code, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(json), cors, null);
    }

    static void Send(Stream s, int code, string type, byte[] body, bool cors, string extra) {
        var sb = new StringBuilder();
        sb.Append("HTTP/1.1 ").Append(code).Append(code == 200 ? " OK" : " X").Append("\r\n");
        sb.Append("Connection: close\r\nCache-Control: no-store\r\n");
        if (cors) sb.Append("Access-Control-Allow-Origin: ").Append(Origin).Append("\r\nVary: Origin\r\n");
        if (extra != null) sb.Append(extra);
        if (type != null) sb.Append("Content-Type: ").Append(type).Append("\r\n");
        sb.Append("Content-Length: ").Append(body == null ? 0 : body.Length).Append("\r\n\r\n");
        byte[] head = Encoding.ASCII.GetBytes(sb.ToString());
        s.Write(head, 0, head.Length);
        if (body != null) s.Write(body, 0, body.Length);
        s.Flush();
    }

    // ---------- Keyboard: each character as a Unicode key event (not affected by Unikey/keyboard layout), then Enter ----------
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

    const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 2, KEYEVENTF_UNICODE = 4;
    const ushort VK_RETURN = 0x0D;

    static INPUT KeyInput(ushort vk, ushort scan, uint flags) {
        var input = new INPUT { type = INPUT_KEYBOARD };
        input.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
        return input;
    }

    /** Type the text into the focused window, then Enter. One line at a time so codes keep their scan order. */
    public static void TypeLine(string text) {
        var inputs = new List<INPUT>();
        foreach (char ch in text) {
            inputs.Add(KeyInput(0, ch, KEYEVENTF_UNICODE));
            inputs.Add(KeyInput(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
        inputs.Add(KeyInput(VK_RETURN, 0, 0));
        inputs.Add(KeyInput(VK_RETURN, 0, KEYEVENTF_KEYUP));
        lock (TypeLock) SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    }
}
'@

[PcTyper]::Key = $Key
[PcTyper]::Origin = $AppOrigin
[PcTyper]::AppUrl = $AppUrl
[PcTyper]::Name = $env:COMPUTERNAME
[PcTyper]::Cert = $Cert

# ---------- Địa chỉ trong mạng LAN (card mạng đang có gateway, tức Wi-Fi/LAN thật) ----------
$ips = @(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
  ForEach-Object { $_.IPv4Address.IPAddress })
if (-not $ips.Count) {
  $ips = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    ForEach-Object { $_.IPAddress })
}

Write-Host ''
Write-Host ' pc-typer đang chạy trên máy' $env:COMPUTERNAME -ForegroundColor Green
Write-Host ''
Write-Host ' 1. Trên điện thoại (cùng Wi-Fi với máy này), mở địa chỉ:'
foreach ($ip in $ips) { Write-Host ("      https://{0}:{1}/?key={2}" -f $ip, $Port, $Key) -ForegroundColor Yellow }
Write-Host '    Lần đầu trình duyệt báo "Kết nối không riêng tư": bấm Nâng cao → Tiếp tục truy cập.'
Write-Host '    Trang sẽ tự chuyển về app, tab "Quét QR".'
Write-Host ' 2. Trên máy tính, bấm vào ô Excel / Google Sheet cần ghi.'
Write-Host ' 3. Quét mã trên điện thoại: mã được gõ vào ô đó rồi xuống dòng.'
Write-Host ''
Write-Host ' Giữ cửa sổ này mở trong lúc quét. Đóng cửa sổ để dừng.' -ForegroundColor DarkGray
Write-Host ''

try {
  [PcTyper]::Run($Port)
} catch {
  # .NET errors arrive wrapped (MethodInvocationException); "address in use" is a SocketException inside.
  if ($_.Exception.InnerException -is [System.Net.Sockets.SocketException]) {
    Write-Host (" Cổng {0} đang được dùng — có thể pc-typer đã chạy ở một cửa sổ khác." -f $Port) -ForegroundColor Red
    exit 1
  }
  throw
}
