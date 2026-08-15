/* Potentia AI Assistant — floating chat widget.
   Talks to a Cloudflare Worker backend that holds the API key server-side.
   See /worker/README.md to deploy the backend, then set WORKER_URL below. */
(function () {
  var WORKER_URL = "https://potentia-assistant.thepotentianetwork.workers.dev/chat";

  var SUGGESTIONS = [
    "What packages do you offer?",
    "How fast can you build my site?",
    "How do I get a quote?"
  ];

  var messages = [];
  var sending = false;

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "class") e.className = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }

  var style = document.createElement("style");
  style.textContent =
    ".pa-launcher{position:fixed;bottom:28px;right:28px;width:56px;height:56px;border-radius:50%;background:var(--chrome,#c8cdd6);border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:3000;box-shadow:0 4px 20px rgba(0,0,0,.4);transition:transform .3s,background .3s}" +
    ".pa-launcher:hover{background:var(--bright,#e8ecf4);transform:scale(1.06)}" +
    ".pa-launcher svg{width:24px;height:24px}" +
    ".pa-panel{position:fixed;bottom:98px;right:28px;width:380px;max-width:calc(100vw - 40px);height:560px;max-height:calc(100vh - 140px);background:var(--deep,#08080f);border:1px solid var(--dim,#2a2d38);display:flex;flex-direction:column;z-index:3000;box-shadow:0 20px 60px rgba(0,0,0,.6);opacity:0;transform:translateY(16px) scale(.98);pointer-events:none;transition:opacity .25s,transform .25s;font-family:'Cormorant Garamond',serif}" +
    ".pa-panel.pa-open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}" +
    ".pa-header{padding:20px 22px;border-bottom:1px solid var(--dim,#2a2d38);display:flex;justify-content:space-between;align-items:flex-start}" +
    ".pa-header-title{font-family:'Syncopate',sans-serif;font-size:11px;letter-spacing:.2em;color:var(--bright,#e8ecf4);text-transform:uppercase;display:flex;align-items:center;gap:8px}" +
    ".pa-dot{width:6px;height:6px;border-radius:50%;background:#6fbf8b;flex-shrink:0}" +
    ".pa-header-sub{font-family:'DM Mono',monospace;font-size:10px;color:var(--silver,#8a909e);margin-top:6px;letter-spacing:.02em}" +
    ".pa-close{background:none;border:none;color:var(--silver,#8a909e);cursor:pointer;font-size:20px;line-height:1;padding:2px 4px}" +
    ".pa-close:hover{color:var(--bright,#e8ecf4)}" +
    ".pa-messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px}" +
    ".pa-msg{font-size:16px;line-height:1.5;font-weight:300;max-width:85%;padding:11px 15px;white-space:pre-wrap}" +
    ".pa-msg.pa-user{align-self:flex-end;background:var(--chrome,#c8cdd6);color:var(--black,#040407)}" +
    ".pa-msg.pa-bot{align-self:flex-start;background:rgba(255,255,255,.04);border:1px solid var(--dim,#2a2d38);color:var(--chrome,#c8cdd6)}" +
    ".pa-typing{align-self:flex-start;display:flex;gap:4px;padding:12px 15px}" +
    ".pa-typing span{width:5px;height:5px;border-radius:50%;background:var(--silver,#8a909e);animation:pa-pulse 1.2s infinite ease-in-out}" +
    ".pa-typing span:nth-child(2){animation-delay:.2s}.pa-typing span:nth-child(3){animation-delay:.4s}" +
    "@keyframes pa-pulse{0%,60%,100%{opacity:.3}30%{opacity:1}}" +
    ".pa-suggestions{display:flex;flex-wrap:wrap;gap:8px;padding:0 20px 14px}" +
    ".pa-chip{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:.03em;color:var(--silver,#8a909e);border:1px solid var(--dim,#2a2d38);padding:8px 12px;cursor:pointer;background:none;transition:all .2s}" +
    ".pa-chip:hover{border-color:var(--silver,#8a909e);color:var(--bright,#e8ecf4)}" +
    ".pa-input-row{display:flex;gap:10px;padding:16px 18px;border-top:1px solid var(--dim,#2a2d38)}" +
    ".pa-input{flex:1;background:rgba(255,255,255,.03);border:1px solid var(--dim,#2a2d38);color:var(--bright,#e8ecf4);font-family:'Cormorant Garamond',serif;font-size:15px;padding:10px 13px;resize:none;outline:none;max-height:90px}" +
    ".pa-input:focus{border-color:var(--silver,#8a909e)}" +
    ".pa-send{background:var(--chrome,#c8cdd6);border:none;color:var(--black,#040407);width:40px;height:40px;flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .2s}" +
    ".pa-send:hover{background:var(--bright,#e8ecf4)}" +
    ".pa-send:disabled{opacity:.4;cursor:not-allowed}" +
    "@media(max-width:480px){.pa-panel{right:10px;left:10px;width:auto;bottom:86px;height:auto;max-height:65vh}.pa-launcher{right:16px;bottom:16px}}";
  document.head.appendChild(style);

  var launcherIcon = el("div", {
    html:
      '<svg viewBox="0 0 24 24" fill="none"><path d="M4 5h16v11H8l-4 4V5z" stroke="#040407" stroke-width="1.6" stroke-linejoin="round"/></svg>'
  });
  var launcher = el("button", { class: "pa-launcher", "aria-label": "Chat with Potentia AI assistant" }, [launcherIcon.firstChild]);

  var closeBtn = el("button", { class: "pa-close", "aria-label": "Close chat" }, [document.createTextNode("✕")]);
  var header = el("div", { class: "pa-header" }, [
    el("div", {}, [
      el("div", { class: "pa-header-title" }, [
        el("span", { class: "pa-dot" }),
        document.createTextNode("Potentia Assistant")
      ]),
      el("div", { class: "pa-header-sub" }, [document.createTextNode("Ask about packages, pricing & timelines")])
    ]),
    closeBtn
  ]);

  var messagesEl = el("div", { class: "pa-messages" });
  var suggestionsEl = el("div", { class: "pa-suggestions" });
  SUGGESTIONS.forEach(function (s) {
    var chip = el("button", { class: "pa-chip" }, [document.createTextNode(s)]);
    chip.addEventListener("click", function () { sendMessage(s); });
    suggestionsEl.appendChild(chip);
  });

  var input = el("textarea", { class: "pa-input", rows: "1", placeholder: "Type a message…" });
  var sendBtn = el("button", {
    class: "pa-send",
    "aria-label": "Send",
    html: '<svg viewBox="0 0 24 24" fill="none" width="16" height="16"><path d="M4 12h16M14 6l6 6-6 6" stroke="#040407" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  });
  var inputRow = el("div", { class: "pa-input-row" }, [input, sendBtn]);

  var panel = el("div", { class: "pa-panel" }, [header, messagesEl, suggestionsEl, inputRow]);

  document.addEventListener("DOMContentLoaded", function () {
    document.body.appendChild(launcher);
    document.body.appendChild(panel);
    addBotMessage("Hi! I'm Potentia's AI assistant — ask me about our packages, add-ons, or how we work. I'll point you to a quote when you're ready.");
  });

  launcher.addEventListener("click", function () {
    panel.classList.toggle("pa-open");
    if (panel.classList.contains("pa-open")) input.focus();
  });
  closeBtn.addEventListener("click", function () { panel.classList.remove("pa-open"); });

  sendBtn.addEventListener("click", function () { sendMessage(input.value); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input.value);
    }
  });
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 90) + "px";
  });

  function addBotMessage(text) {
    messagesEl.appendChild(el("div", { class: "pa-msg pa-bot" }, [document.createTextNode(text)]));
    scrollToBottom();
  }
  function addUserMessage(text) {
    messagesEl.appendChild(el("div", { class: "pa-msg pa-user" }, [document.createTextNode(text)]));
    scrollToBottom();
  }
  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  var typingEl = null;
  function showTyping() {
    typingEl = el("div", { class: "pa-typing" }, [el("span"), el("span"), el("span")]);
    messagesEl.appendChild(typingEl);
    scrollToBottom();
  }
  function hideTyping() {
    if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
    typingEl = null;
  }

  function sendMessage(raw) {
    var text = (raw || "").trim();
    if (!text || sending) return;

    if (suggestionsEl.parentNode) suggestionsEl.remove();

    addUserMessage(text);
    messages.push({ role: "user", content: text.slice(0, 1000) });
    input.value = "";
    input.style.height = "auto";
    sending = true;
    sendBtn.disabled = true;
    showTyping();

    if (!WORKER_URL || WORKER_URL.indexOf("YOUR-WORKER-SUBDOMAIN") !== -1) {
      setTimeout(function () {
        hideTyping();
        addBotMessage("Thanks for the message! Our AI backend isn't connected yet — in the meantime, reach us directly on the contact page and we'll get back to you within 24 hours.");
        sending = false;
        sendBtn.disabled = false;
      }, 500);
      return;
    }

    fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messages.slice(-20) })
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Bad response");
        return res.json();
      })
      .then(function (data) {
        hideTyping();
        var reply = data && data.reply ? data.reply : "Sorry, could you rephrase that?";
        addBotMessage(reply);
        messages.push({ role: "assistant", content: reply });
      })
      .catch(function () {
        hideTyping();
        addBotMessage("Sorry, I'm having trouble connecting right now — please reach out on our contact page and we'll get back to you within 24 hours.");
      })
      .finally(function () {
        sending = false;
        sendBtn.disabled = false;
      });
  }
})();
