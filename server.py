from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path


STATE_FILE = Path("ranker-state.json")
MAX_BODY_BYTES = 1_000_000


class CourseRankerHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/state":
            self.send_state()
            return

        super().do_GET()

    def do_POST(self):
        if self.path == "/api/state":
            self.save_state()
            return

        self.send_error(404, "Not found")

    def send_state(self):
        if not STATE_FILE.exists():
            self.send_json({})
            return

        try:
            data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            self.send_error(500, "Saved state file is not valid JSON")
            return

        self.send_json(data)

    def save_state(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400, "Invalid Content-Length")
            return

        if content_length > MAX_BODY_BYTES:
            self.send_error(413, "State file is too large")
            return

        raw_body = self.rfile.read(content_length)
        try:
            data = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_error(400, "Request body must be JSON")
            return

        STATE_FILE.write_text(f"{json.dumps(data, indent=2)}\n", encoding="utf-8")
        self.send_json({"saved": True})

    def send_json(self, data):
        body = f"{json.dumps(data)}\n".encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("localhost", 8000), CourseRankerHandler)
    print("Serving Course Ranker on http://localhost:8000")
    server.serve_forever()
