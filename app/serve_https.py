"""Serve the Locate app over HTTPS on the local network.

Phones only give a web page its GPS location on an https:// link, so the phone
tracker (tracker.html) needs this. Uses a self-signed certificate: the phone
shows a warning once - tap "Advanced" -> "Proceed".

    cd app
    python serve_https.py            # https://<laptop-ip>:8443

Needs ../certs/cert.pem and ../certs/key.pem (see README, "Phone as the tracker").
They live outside app/ so the private key is never served or uploaded.
"""
import http.server
import os
import socket
import ssl

PORT = 8443
HERE = os.path.dirname(os.path.abspath(__file__))
CERTS = os.path.join(HERE, "..", "certs")


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent; picks the LAN interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".webmanifest": "application/manifest+json", ".js": "text/javascript"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)


ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(os.path.join(CERTS, "cert.pem"), os.path.join(CERTS, "key.pem"))
httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
ip = lan_ip()
print(f"Locate app:     https://{ip}:{PORT}/")
print(f"Phone tracker:  https://{ip}:{PORT}/tracker.html")
print("First visit on each phone: 'Advanced' -> 'Proceed' (self-signed certificate). Ctrl+C to stop.")
httpd.serve_forever()
