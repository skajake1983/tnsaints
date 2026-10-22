"""See the emails the local Worker would send, without sending any.

.dev.vars points RESEND_ENDPOINT at 127.0.0.1:8799, so in local development
every email the Worker "sends" arrives here instead of at Resend. Nothing
leaves this machine.

    python tests/mail_viewer.py        then open http://127.0.0.1:8799/

The page lists each email (newest first) with its subject, recipients and
time; click one to read it as the recipient would, with its plain-text
version and headers (List-Unsubscribe, for invitations) underneath.

Stop it before running the test suites: they start their own sink on 8799.
Kept in memory only; closing it forgets everything.
"""
import html
import json
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8799
_mail = []
_lock = threading.Lock()

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title><style>
body{{font-family:Segoe UI,Arial,sans-serif;margin:0;padding:16px;background:#f3f5f9;color:#13233d}}
main{{max-width:900px;margin:0 auto}} h1{{font-size:1.3rem}} table{{width:100%;border-collapse:collapse;background:#fff}}
th,td{{text-align:left;padding:8px 10px;border-bottom:1px solid #dfe3ea;font-size:.92rem;vertical-align:top}}
a{{color:#0b3a8d}} .meta{{background:#fff;padding:12px 14px;border-radius:8px;margin-bottom:12px}}
iframe{{width:100%;height:640px;border:1px solid #dfe3ea;background:#fff;border-radius:8px}}
pre{{white-space:pre-wrap;background:#fff;padding:12px;border-radius:8px;border:1px solid #dfe3ea}}
</style></head><body><main>{body}</main></body></html>"""


def _to(m):
    to = m.get("to")
    return ", ".join(to) if isinstance(to, list) else str(to or "")


class Viewer(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, body, kind="text/html; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        # The email bodies are our own, but nothing here needs to run script.
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; frame-src 'self'")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        try:
            message = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except (ValueError, json.JSONDecodeError):
            message = {}
        with _lock:
            message["_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            _mail.append(message)
            n = len(_mail)
        print(f"#{n}  {message.get('subject', '(no subject)')}  ->  {_to(message)}", flush=True)
        self._send(200, json.dumps({"id": f"local-{n}"}), "application/json")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        with _lock:
            mail = list(_mail)
        if path == "/":
            rows = "".join(
                f'<tr><td>{i + 1}</td><td><a href="/{i + 1}">{html.escape(m.get("subject", "(no subject)"))}</a></td>'
                f'<td>{html.escape(_to(m))}</td><td>{html.escape(m.get("_at", ""))}</td></tr>'
                for i, m in reversed(list(enumerate(mail))))
            body = (f"<h1>Local emails ({len(mail)})</h1><p>Nothing here was sent. Refresh to see new ones.</p>"
                    f"<table><tr><th>#</th><th>Subject</th><th>To</th><th>When</th></tr>{rows}</table>")
            return self._send(200, PAGE.format(title="Local emails", body=body))
        if path.endswith("/body") and path[1:-5].isdigit():
            i = int(path[1:-5]) - 1
            if 0 <= i < len(mail):
                return self._send(200, mail[i].get("html") or f"<pre>{html.escape(mail[i].get('text', ''))}</pre>")
        if path[1:].isdigit():
            i = int(path[1:]) - 1
            if 0 <= i < len(mail):
                m = mail[i]
                meta = (f'<div class="meta"><a href="/">&larr; All emails</a><h1>{html.escape(m.get("subject", ""))}</h1>'
                        f"<div>To: {html.escape(_to(m))}</div><div>From: {html.escape(str(m.get('from', '')))}</div>"
                        f"<div>Reply to: {html.escape(str(m.get('reply_to', '')))}</div><div>{html.escape(m.get('_at', ''))}</div></div>")
                frame = f'<iframe sandbox src="/{i + 1}/body" title="Email body"></iframe>'
                text = f"<h2>Plain text</h2><pre>{html.escape(m.get('text', '(none)'))}</pre>"
                headers = f"<h2>Headers</h2><pre>{html.escape(json.dumps(m.get('headers', {}), indent=2))}</pre>"
                return self._send(200, PAGE.format(title=m.get("subject", "Email"), body=meta + frame + text + headers))
        self._send(404, PAGE.format(title="Not found", body='<p>No such email. <a href="/">All emails</a></p>'))


if __name__ == "__main__":
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Viewer)
    except OSError:
        sys.exit(f"Port {PORT} is busy: is a test suite running? Stop it and try again.")
    print(f"Local emails: http://127.0.0.1:{PORT}/  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
