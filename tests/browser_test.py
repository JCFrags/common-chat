"""Run browser acceptance tests against a temporary server and a simulated model.

Install playwright and Chromium before use. Set CHROMIUM_PATH for a system browser.
No real model, provider credential, or production data directory is used.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get("BROWSER_ARTIFACTS", tempfile.mkdtemp(prefix="common-chat-browser-artifacts-")))
ARTIFACTS.mkdir(parents=True, exist_ok=True)
server = subprocess.Popen(["node", "tests/browser-server.mjs"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
results: list[dict[str, str]] = []

def record(name: str) -> None:
    results.append({"name": name, "status": "passed"})
    print(f"PASS {name}", flush=True)

try:
    config = json.loads(server.stdout.readline())
    with sync_playwright() as p:
        executable = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium")
        browser = p.chromium.launch(headless=True, **({"executable_path": executable} if executable else {}), args=["--no-sandbox"])
        desktop = browser.new_context(viewport={"width": 1440, "height": 1000}, color_scheme="dark")
        mobile = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=1, color_scheme="dark")
        errors: list[str] = []
        page = desktop.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(config["url"])
        page.locator("#password").fill(config["password"])
        page.get_by_role("button", name="Sign in", exact=True).click()
        expect(page.locator("#app")).to_be_visible()
        page.get_by_role("button", name="Connections", exact=True).click()
        page.locator("#connection-name").fill("Local models")
        page.locator("#connection-url").fill(config["modelUrl"])
        page.locator("#connection-models").fill("demo-model\nslow\nplain")
        page.locator("#cap-vision").check()
        page.get_by_role("button", name="Save connection", exact=True).click()
        expect(page.locator("#connections-dialog")).not_to_be_visible()
        expect(page.locator("#model-input")).to_have_value("demo-model")
        record("Create a model connection through the browser")
        page.locator("#prompt").fill("Keep this conversation available on my other devices.")
        page.get_by_role("button", name="Send", exact=True).click()
        expect(page.locator("article.assistant .message-body").last).to_contain_text("Hello from the test model. 🌍")
        expect(page.locator("#stop")).to_be_hidden(timeout=10000)
        cid = page.url.split("#")[1]
        snapshot = page.evaluate("async id => (await fetch('/api/conversations/'+id)).json()", cid)
        assert len(snapshot["messages"]) == 2
        record("Send a message and persist the streaming answer")
        page.screenshot(path=str(ARTIFACTS / "desktop.png"), full_page=True)
        phone = mobile.new_page()
        phone.on("pageerror", lambda error: errors.append(str(error)))
        phone.goto(config["url"] + "#" + cid)
        phone.locator("#password").fill(config["password"])
        phone.get_by_role("button", name="Sign in", exact=True).click()
        expect(phone.locator("article.user .message-body")).to_contain_text("Keep this conversation available")
        expect(phone.locator("article.assistant .message-body").last).to_contain_text("Hello from the test model. 🌍")
        assert phone.evaluate("Object.keys(localStorage)") == []
        assert phone.evaluate("async () => (await indexedDB.databases()).length") == 0
        phone.screenshot(path=str(ARTIFACTS / "mobile.png"), full_page=True)
        record("A separate mobile browser loads the same history without browser storage")
        page.locator("#model-input").fill("plain")
        page.locator("#model-input").dispatch_event("change")
        page.get_by_role("button", name="Regenerate", exact=True).click()
        expect(page.locator("article.assistant .message-body").last).to_contain_text("A non-streaming answer.")
        expect(page.locator("#stop")).to_be_hidden()
        expect(phone.locator("article.assistant .message-body").last).to_contain_text("A non-streaming answer.")
        snapshot = page.evaluate("async id => (await fetch('/api/conversations/'+id)).json()", cid)
        assert len(snapshot["messages"]) == 3
        assert len([m for m in snapshot["messages"] if m["role"] == "assistant"]) == 2
        record("Regeneration preserves both responses and updates the other device")
        page.get_by_role("button", name="Edit", exact=True).click()
        page.locator("#prompt").fill("This is an edited prompt on a new branch.")
        page.get_by_role("button", name="Send", exact=True).click()
        expect(page.locator("article.user .message-body")).to_contain_text("edited prompt")
        expect(page.locator("#stop")).to_be_hidden()
        snapshot = page.evaluate("async id => (await fetch('/api/conversations/'+id)).json()", cid)
        assert len([m for m in snapshot["messages"] if m["role"] == "user"]) == 2
        page.get_by_role("button", name="Previous", exact=True).first.click()
        expect(page.locator("article.user .message-body")).to_contain_text("Keep this conversation available")
        record("Edit and branch navigation retain the original message")
        page.locator("#file-input").set_input_files({"name": "note.txt", "mimeType": "text/plain", "buffer": b"The shared code is 73."})
        expect(page.locator("#attachment-list")).to_contain_text("note.txt")
        page.locator("#prompt").fill("Read the attached note.")
        page.get_by_role("button", name="Send", exact=True).click()
        expect(page.locator("#attachment-list")).to_be_empty()
        expect(page.locator("#stop")).to_be_hidden()
        expect(phone.locator("a.file-link")).to_contain_text("note.txt")
        record("Upload an attachment and read its record on another device")
        page.locator("#model-input").fill("slow")
        page.locator("#prompt").fill("Start a response that I will stop from my phone.")
        page.get_by_role("button", name="Send", exact=True).click()
        expect(phone.locator("#stop")).to_be_visible()
        expect(phone.locator("article.assistant .message-body").last).to_contain_text("This response", timeout=10000)
        phone.locator("#stop").click()
        expect(page.locator("article.assistant").last.locator(".badge")).to_have_text("cancelled")
        record("Cancel a generation from the other device and retain partial output")
        page.locator("#prompt").fill("Continue this response after I close the desktop browser.")
        page.get_by_role("button", name="Send", exact=True).click()
        expect(page.locator("#stop")).to_be_visible()
        expect(page.locator("#prompt")).to_have_value("")
        page.close()
        expect(phone.locator("#stop")).to_be_hidden(timeout=15000)
        expect(phone.locator("article.assistant .message-body").last).to_contain_text("browser disconnects.")
        snapshot = phone.evaluate("async id => (await fetch('/api/conversations/'+id)).json()", cid)
        latest = next(m for m in snapshot["messages"] if m["id"] == snapshot["activeLeaf"])
        assert latest["status"] == "complete"
        record("Generation completes after the initiating browser closes")
        page = desktop.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(config["url"] + "#" + cid)
        expect(page.locator("article.assistant .message-body").last).to_contain_text("browser disconnects.")
        record("A reopened browser resumes the saved conversation")
        page.get_by_role("button", name="Settings and data", exact=True).click()
        page.locator("#theme-select").select_option("light")
        expect(phone.locator("html")).not_to_have_class("dark")
        page.locator("#theme-select").select_option("dark")
        expect(phone.locator("html")).to_have_class("dark")
        with page.expect_download() as downloaded:
            page.get_by_role("button", name="Export all conversations", exact=True).click()
        target = ARTIFACTS / "export.json"
        downloaded.value.save_as(target)
        exported = json.loads(target.read_text())
        assert exported["format"] == "common-chat"
        assert len(exported["conversations"][0]["messages"]) >= 9
        page.locator("#preferences-dialog").get_by_role("button", name="Close", exact=True).click()
        record("Server-backed appearance settings and downloadable export work")
        imported = '{"type":"session","id":"source","name":"Imported session","currNode":"u"}\n{"type":"message","message":{"id":"u","parent":null,"role":"user","content":"Imported from llama.cpp","timestamp":123}}'
        page.locator("#import-input").set_input_files({"name": "session.jsonl", "mimeType": "application/jsonl", "buffer": imported.encode()})
        expect(page.locator("#import-output")).to_contain_text("Imported 1 conversations and 1 messages.")
        page.locator("#import-dialog").get_by_role("button", name="Close", exact=True).click()
        expect(page.locator("#conversation-list")).to_contain_text("Imported session")
        record("Import current upstream JSONL through the browser")
        assert not errors, errors
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        assert phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        record("No JavaScript errors or horizontal page overflow on desktop and mobile")
        browser.close()
    (ARTIFACTS / "browser-results.json").write_text(json.dumps({"tests": results, "passed": len(results), "failed": 0}, indent=2))
    print(f"Artifacts: {ARTIFACTS}")
finally:
    server.terminate()
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait(timeout=5)
    errors_from_server = server.stderr.read()
    if errors_from_server:
        print(errors_from_server, file=sys.stderr)
