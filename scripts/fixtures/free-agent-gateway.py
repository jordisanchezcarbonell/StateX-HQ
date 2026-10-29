"""Actual secure Gateway + FastAPI, with httpx MockTransport instead of any upstream socket."""
import asyncio
import json
from pathlib import Path
import socket
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "free-model-router"))
import httpx
import uvicorn
from main import create_app
from router.secure_gateway import Gateway, BASE

# Fail closed even if a future gateway change accidentally constructs a non-mock transport.
def no_connect(*args, **kwargs):
    raise AssertionError("External socket connections are forbidden in this fixture")
socket.socket.connect = no_connect
socket.socket.connect_ex = no_connect

stats = {"catalogs": 0, "models": [], "tools": [], "tool_results": [], "routing": []}

def mock(request):
    if str(request.url) == BASE + "/models":
        stats["catalogs"] += 1
        return httpx.Response(200, json={"data": [
            {"id": "paid/model:free", "pricing": {"prompt": "0.01", "completion": "0"}},
            {"id": "unknown/model", "pricing": {"prompt": "0"}},
            {"id": "fixture/free", "pricing": {"prompt": "0", "completion": "0"}}
        ]})
    assert str(request.url) == BASE + "/chat/completions", "Unexpected upstream route"
    body = json.loads(request.content)
    stats["models"].append(body["model"])
    stats["routing"].append(body["provider"])
    stats["tools"].append([t["function"]["name"] for t in body["tools"]])
    stats["tool_results"] = [m for m in body["messages"] if m["role"] == "tool"]
    n = len(stats["tool_results"])
    calls = [
        ("Read", {"file_path": "README.md"}),
        ("Edit", {"file_path": "README.md", "old_string": "# Fixture\n", "new_string": "# Fixture\nStateX HQ Agent Test OK\n"}),
        ("Read", {"file_path": "README.md"}),
    ]
    if n < len(calls):
        name, args = calls[n]
        message = {"role": "assistant", "content": None, "tool_calls": [{"id": f"call-{n}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}
        finish = "tool_calls"
    else:
        assert "StateX HQ Agent Test OK" in stats["tool_results"][-1]["content"]
        message = {"role": "assistant", "content": "Verified README.md: StateX HQ Agent Test OK"}
        finish = "stop"
    return httpx.Response(200, json={"model": "fixture/free", "choices": [{"message": message, "finish_reason": finish}], "usage": {"prompt_tokens": 30, "completion_tokens": 10, "cost": 0}})

app = create_app(lambda: Gateway("offline-fixture-key", client=httpx.AsyncClient(transport=httpx.MockTransport(mock))))
@app.get("/test/stats")
def result():
    return stats

async def main():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    print(json.dumps({"port": sock.getsockname()[1]}), flush=True)
    server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
    await server.serve(sockets=[sock])

asyncio.run(main())
