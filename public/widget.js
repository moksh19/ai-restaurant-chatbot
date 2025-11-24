// public/widget.js
(function () {
  function initWidget() {
    const scriptTag = document.currentScript || document.querySelector('script[src*="widget.js"]');
    if (!scriptTag) {
      console.error("Chat widget: script tag not found");
      return;
    }

    const backendUrl =
      scriptTag.getAttribute("data-backend-url") ||
      window.location.origin;
    const restaurantId = scriptTag.getAttribute("data-restaurant-id");

    if (!restaurantId) {
      console.error("Chat widget: data-restaurant-id is required");
      return;
    }

    // Make sure body exists
    const body = document.body || document.getElementsByTagName("body")[0];
    if (!body) {
      console.error("Chat widget: <body> not found");
      return;
    }

    const widget = document.createElement("div");
    widget.style.position = "fixed";
    widget.style.bottom = "20px";
    widget.style.right = "20px";
    widget.style.width = "320px";
    widget.style.maxHeight = "500px";
    widget.style.background = "#ffffff";
    widget.style.border = "1px solid #ddd";
    widget.style.borderRadius = "12px";
    widget.style.boxShadow = "0 4px 10px rgba(0,0,0,0.1)";
    widget.style.display = "flex";
    widget.style.flexDirection = "column";
    widget.style.overflow = "hidden";
    widget.style.fontFamily = "system-ui, -apple-system, BlinkMacSystemFont, Arial";

    widget.innerHTML = `
      <div style="background:#111827;color:#fff;padding:10px 14px;font-size:14px;font-weight:bold;">
        Chat with us 🤖
      </div>
      <div id="chat-messages" style="flex:1;padding:10px;overflow-y:auto;font-size:14px;background:#f9fafb;"></div>
      <div style="display:flex;padding:8px;border-top:1px solid #e5e7eb;background:#fff;">
        <input id="chat-input" type="text" placeholder="Ask about menu, offers, hours..." style="flex:1;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;"/>
        <button id="chat-send" style="margin-left:6px;padding:8px 12px;border:none;border-radius:6px;background:#16a34a;color:#fff;font-size:14px;cursor:pointer;">Send</button>
      </div>
    `;

    body.appendChild(widget);

    const messagesEl = widget.querySelector("#chat-messages");
    const inputEl = widget.querySelector("#chat-input");
    const sendBtn = widget.querySelector("#chat-send");

    let history = [];

    function addMessage(text, sender) {
      const div = document.createElement("div");
      div.style.marginBottom = "8px";
      div.style.lineHeight = "1.4";
      div.style.textAlign = sender === "user" ? "right" : "left";

      const span = document.createElement("span");
      span.textContent = text;
      span.style.display = "inline-block";
      span.style.padding = "6px 10px";
      span.style.borderRadius = "10px";
      span.style.maxWidth = "80%";
      if (sender === "user") {
        span.style.background = "#2563eb";
        span.style.color = "#fff";
      } else {
        span.style.background = "#e5e7eb";
        span.style.color = "#111827";
      }

      div.appendChild(span);
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function sendMessage() {
      const text = inputEl.value.trim();
      if (!text) return;

      addMessage(text, "user");
      inputEl.value = "";
      sendBtn.disabled = true;

      try {
        const response = await fetch(backendUrl + "/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            restaurantId,
            message: text,
            history,
          }),
        });

        const data = await response.json();
        if (data.error) {
          addMessage("Error: " + data.error, "bot");
        } else {
          const reply = data.reply || "(No reply)";
          addMessage(reply, "bot");
          history.push({ role: "user", content: text });
          history.push({ role: "assistant", content: reply });
        }
      } catch (e) {
        console.error(e);
        addMessage("Sorry, something went wrong.", "bot");
      } finally {
        sendBtn.disabled = false;
        inputEl.focus();
      }
    }

    sendBtn.addEventListener("click", sendMessage);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendMessage();
    });

    // Greeting
    addMessage("Hi! I’m your AI assistant. Ask me about our menu, offers, hours, or ordering.", "bot");
  }

  // Wait for DOM to be ready so <body> exists
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initWidget);
  } else {
    initWidget();
  }
})();
