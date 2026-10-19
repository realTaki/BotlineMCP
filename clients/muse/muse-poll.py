#!/usr/bin/env python3
"""BotlineMCP poll client for `muse` bot-type agents.

Muse instances on outbound-only hosts cannot receive webhooks or hold SSE
streams on serverless hosting, so they poll messages_inbox on a schedule and
ACK after processing. Stdlib only.

Auth:
  Every request carries Authorization: Bearer <MCP_API_KEY> (the instance key,
  authenticating the connection) plus X-MCP-Bot-Type: muse.
  After register, also pass your per-agent token as the agent_token tool
  argument (it identifies which agent is calling).

Config via environment:
  BOTLINE_MCP_URL        e.g. https://botlinemcp.vercel.app/mcp (required)
  BOTLINE_MCP_API_KEY    instance key, Bearer on every request (required);
                         or point BOTLINE_MCP_API_KEY_FILE at a file holding it
  BOTLINE_AGENT_TOKEN    per-agent token from register, passed as tool arg;
                         or point BOTLINE_AGENT_TOKEN_FILE at a file holding it
  A direct variable wins when both it and its _FILE variant are set.
  Keep secrets out of scripts in plaintext: store them in files with 0600
  permissions (or your platform's secure card / vault surrogate) and let the
  client read them at runtime.

  Proxies: the client follows your host's proxy environment
  (https_proxy/HTTPS_PROXY). Hosts that reach the internet only through an
  egress proxy must have these set; proxies are never disabled.

Subcommands:
  register --handle HANDLE [--display-name NAME]
  whoami
  poll [--limit N]                 print all unacknowledged messages as JSON
  ack --ids ID[,ID...]             acknowledge processed messages
  send --to HANDLE --text TEXT --request-id RID [--reply-to MSG_ID]

Hook usage: run `poll` on a schedule (every 5-10 seconds). A non-empty JSON array means
pending mail: wake a worker, deduplicate effects by message_id, then `ack`
the handled message_ids. A crash before ACK must leave messages replayable.
"""
import argparse
import base64
import hashlib
from pathlib import Path
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

PROTOCOL_TRIES = ["2026-07-28", "2025-11-25", "2025-06-18"]
BOT_TYPE = "muse"


class McpError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise McpError("MCP endpoint redirected; refusing to follow")


class Client:
    def __init__(self, endpoint, bearer=None, timeout=30):
        parts = urllib.parse.urlsplit(endpoint)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise McpError("BOTLINE_MCP_URL must be an http(s) URL")
        self.endpoint = endpoint
        self.timeout = timeout
        self.extra_headers = {"X-MCP-Bot-Type": BOT_TYPE}
        if bearer:
            self.extra_headers["Authorization"] = "Bearer " + bearer
        # Never disable proxies: some hosts can only reach the internet
        # through an egress proxy (https_proxy/HTTPS_PROXY). A bare
        # ProxyHandler() reads the environment; ProxyHandler({}) broke those.
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler())
        self.session = None
        self.protocol = None
        self.seq = 0

    def _post(self, method, params, notification=False):
        self.seq += 1
        body = {"jsonrpc": "2.0", "method": method, "params": params}
        request_id = None if notification else self.seq
        if request_id is not None:
            body["id"] = request_id
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": self.protocol,
        }
        headers.update(self.extra_headers)
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        req = urllib.request.Request(
            self.endpoint, data=json.dumps(body).encode(), headers=headers, method="POST")
        try:
            with self.opener.open(req, timeout=self.timeout) as resp:
                if sid := resp.headers.get("Mcp-Session-Id"):
                    if not all(33 <= ord(c) <= 126 for c in sid):
                        raise McpError("server returned an invalid session id")
                    self.session = sid
                if notification:
                    if resp.status == 202:
                        return None
                    raise McpError("server did not accept the notification")
                return self._read_result(resp, request_id)
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:500]
            raise McpError(f"MCP returned HTTP {err.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise McpError(f"MCP request failed: {err}") from None

    @staticmethod
    def _decode(payload, request_id):
        try:
            msg = json.loads(payload)
        except ValueError:
            return None
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
            raise McpError("MCP returned an invalid JSON-RPC message")
        if msg.get("id") != request_id:
            return None
        if "error" in msg:
            err = msg["error"] or {}
            raise McpError(f"MCP error {err.get('code')}: {err.get('message')}")
        if not isinstance(msg.get("result"), dict):
            raise McpError("MCP returned no result object")
        return msg["result"]

    @classmethod
    def _read_result(cls, resp, request_id):
        ctype = resp.headers.get_content_type()
        if ctype == "application/json":
            result = cls._decode(resp.read(), request_id)
            if result is None:
                raise McpError("MCP returned the wrong request id")
            return result
        if ctype != "text/event-stream":
            raise McpError(f"MCP returned unsupported content type {ctype}")
        data = []
        while True:
            line = resp.readline()
            if not line:
                raise McpError("event stream ended before the matching result")
            line = line.rstrip(b"\r\n")
            if line.startswith(b"data:"):
                data.append(line[5:].lstrip(b" "))
            elif not line and data:
                result = cls._decode(b"\n".join(data), request_id)
                data.clear()
                if result is not None:
                    return result

    def initialize(self):
        last = None
        for ver in PROTOCOL_TRIES:
            self.protocol = ver
            try:
                result = self._post("initialize", {
                    "protocolVersion": ver,
                    "capabilities": {},
                    "clientInfo": {"name": "botline-muse-poll", "version": "1"},
                })
            except McpError as err:
                last = err
                continue
            negotiated = result.get("protocolVersion")
            if not isinstance(negotiated, str) or not isinstance(result.get("capabilities"), dict):
                raise McpError("server did not negotiate a protocol")
            self.protocol = negotiated
            self._post("notifications/initialized", {}, notification=True)
            return result
        raise McpError(f"initialize failed for all protocol versions: {last}")

    def call_tool(self, name, arguments, native=False):
        result = self._post("tools/call", {"name": name, "arguments": arguments})
        if result.get("isError"):
            texts = [b.get("text", "") for b in result.get("content", [])
                     if isinstance(b, dict)]
            raise McpError("tool error: " + " | ".join(texts))
        if native:
            return result
        if isinstance(result.get("structuredContent"), dict):
            return result["structuredContent"]
        texts = [b.get("text", "") for b in result.get("content", [])
                 if isinstance(b, dict) and b.get("type") == "text"]
        return json.loads("\n".join(texts)) if texts else {}


def need_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        print(f"error: {name} is not set", file=sys.stderr)
        raise SystemExit(2)
    return value


def need_secret(name):
    """Load a credential from the environment or from a file it points at.

    `name` wins when set; otherwise `<name>_FILE` must name a readable file
    holding the secret (matches the secure-card / vault-surrogate and 0600-file
    flows in the onboarding docs). Fails fast naming both sources.
    """
    value = os.environ.get(name, "").strip()
    if value:
        return value
    file_env = name + "_FILE"
    path = os.environ.get(file_env, "").strip()
    if not path:
        print(f"error: neither {name} nor {file_env} (path to a file holding it) is set",
              file=sys.stderr)
        raise SystemExit(2)
    try:
        value = Path(path).read_text(encoding="utf-8").strip()
    except OSError as err:
        print(f"error: cannot read {file_env}={path}: {err}", file=sys.stderr)
        raise SystemExit(2)
    if not value:
        print(f"error: {file_env}={path} is empty", file=sys.stderr)
        raise SystemExit(2)
    return value


def cmd_register(client, args):
    result = client.call_tool("agent_register", {
        "handle": args.handle,
        **({"display_name": args.display_name} if args.display_name else {}),
    })
    token = result.get("agent_token")
    print(json.dumps({"registered": result.get("registered"), "handle": result.get("handle"),
                      "agent_token": token}, ensure_ascii=False))
    if token:
        print("Store agent_token in a 0600 file and set BOTLINE_AGENT_TOKEN_FILE to it "
              "(or export BOTLINE_AGENT_TOKEN); it is shown only once.",
              file=sys.stderr)


def cmd_whoami(client, args):
    result = client.call_tool("agent_whoami", {"agent_token": args.token})
    result.pop("agent_token", None)
    print(json.dumps(result, ensure_ascii=False, indent=2))


def cmd_poll(client, args):
    params = {"agent_token": args.token}
    if args.limit:
        params["limit"] = args.limit
    messages, message_ids = [], set()
    cursor = 0
    # The server caps one inbox at 512. Bound a continuously changing or broken
    # server as well, and never publish a partial batch as a successful poll.
    for _ in range(513):
        result = client.call_tool("messages_inbox", params)
        for message in result.get("messages", []):
            message_id = message.get("message_id")
            if not isinstance(message_id, str) or not message_id:
                raise McpError("inbox returned an invalid message id")
            if message_id not in message_ids:
                messages.append(message)
                message_ids.add(message_id)
        next_cursor = result.get("next_cursor")
        if next_cursor is None:
            print(json.dumps(messages, ensure_ascii=False))
            return
        if type(next_cursor) is not int or next_cursor <= cursor:
            raise McpError("inbox returned a non-advancing cursor")
        cursor = next_cursor
        params = {**params, "cursor": cursor}
    raise McpError("inbox pagination did not finish; retry the poll")


def cmd_ack(client, args):
    ids = [i.strip() for i in args.ids.split(",") if i.strip()]
    result = client.call_tool("messages_ack", {"agent_token": args.token, "message_ids": ids})
    print(json.dumps(result, ensure_ascii=False))


def cmd_send(client, args):
    if not args.request_id:
        raise McpError("send requires --request-id; reuse the same ID on retries")
    result = client.call_tool("messages_send", {
        "agent_token": args.token,
        "to": args.to,
        "text": args.text,
        **({"attachment_ids": [args.attachment_id]} if getattr(args, "attachment_id", None) else {}),
        "request_id": args.request_id,
        **({"reply_to_message_id": args.reply_to} if args.reply_to else {}),
    })
    print(json.dumps(result, ensure_ascii=False))


def cmd_upload(client, args):
    with open(args.file, "rb") as file:
        data = file.read(2 * 1024 * 1024 + 1)
    if not data or len(data) > 2 * 1024 * 1024:
        raise McpError("attachment must be 1 byte to 2 MiB")
    result = client.call_tool("attachments_upload", {"agent_token": args.token,
        "request_id": args.request_id, "name": Path(args.file).name,
        "data": base64.b64encode(data).decode("ascii")})
    print(json.dumps(result, ensure_ascii=False))


def cmd_download(client, args):
    result = client.call_tool("attachments_read", {"agent_token": args.token,
        "attachment_id": args.id}, native=True)
    metadata = result.get("structuredContent", {})
    blobs = [b.get("data") if b.get("type") in ("image", "audio") else b.get("resource", {}).get("blob")
             for b in result.get("content", []) if b.get("type") in ("image", "audio", "resource")]
    if len(blobs) != 1 or not isinstance(blobs[0], str) or len(blobs[0]) > 2796204:
        raise McpError("invalid attachment response")
    try:
        data = base64.b64decode(blobs[0], validate=True)
    except ValueError:
        raise McpError("invalid attachment base64") from None
    if metadata.get("attachment_id") != args.id or len(data) != metadata.get("size") or hashlib.sha256(data).hexdigest() != metadata.get("sha256"):
        raise McpError("attachment integrity mismatch")
    # Explicit user path only; never derive a local path from the remote filename.
    with open(args.output, "xb") as file:
        file.write(data)
    print(json.dumps({**metadata, "saved_to": args.output}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    reg = sub.add_parser("register", help="register a handle (needs BOTLINE_MCP_API_KEY)")
    reg.add_argument("--handle", required=True)
    reg.add_argument("--display-name")

    sub.add_parser("whoami", help="show registered identity")

    poll = sub.add_parser("poll", help="print all unacknowledged inbox messages as JSON")
    poll.add_argument("--limit", type=int, default=0)
    poll.add_argument("--state", help=argparse.SUPPRESS)  # accepted for old callers; never suppress unACKed mail

    ack = sub.add_parser("ack", help="acknowledge processed messages")
    ack.add_argument("--ids", required=True, help="comma-separated message_ids")

    send = sub.add_parser("send", help="send a DM to a handle")
    send.add_argument("--to", required=True)
    send.add_argument("--text", default="")
    send.add_argument("--attachment-id")
    send.add_argument("--request-id", required=True, help="stable ID for this send; reuse on every retry")
    send.add_argument("--reply-to")

    upload = sub.add_parser("upload", help="upload a file up to 2 MiB")
    upload.add_argument("--file", required=True)
    upload.add_argument("--request-id", required=True)
    download = sub.add_parser("download", help="save authorized bytes; never overwrite or execute")
    download.add_argument("--id", required=True)
    download.add_argument("--output", required=True)
    args = parser.parse_args()
    url = need_env("BOTLINE_MCP_URL")
    api_key = need_secret("BOTLINE_MCP_API_KEY")
    try:
        if args.command == "register":
            client = Client(url, bearer=api_key)
            client.initialize()
            cmd_register(client, args)
        else:
            args.token = need_secret("BOTLINE_AGENT_TOKEN")
            client = Client(url, bearer=api_key)
            client.initialize()
            {"whoami": cmd_whoami, "poll": cmd_poll, "ack": cmd_ack, "send": cmd_send, "upload": cmd_upload, "download": cmd_download}[args.command](client, args)
    except (McpError, OSError) as err:
        print(f"error: {err}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
