import http.server
import socketserver
import urllib.parse
import sys

class LoggerHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        if parsed_path.path == '/log':
            query = urllib.parse.parse_qs(parsed_path.query)
            msg = query.get('msg', [''])[0]
            print(f"[BROWSER LOG] {msg}")
            sys.stdout.flush()
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(b"OK")
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.end_headers()

    def log_message(self, format, *args):
        pass # Suppress standard logging

if __name__ == "__main__":
    PORT = 9999
    with socketserver.TCPServer(("", PORT), LoggerHandler) as httpd:
        print("Logger running on port", PORT)
        sys.stdout.flush()
        httpd.serve_forever()
