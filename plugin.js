import openai from 'https://cdn.jsdelivr.net/npm/openai@6.7.0/+esm'
import { style } from './style.js';
import { prompts } from './prompts.js';



export default (app) => {
    console.log("This is the context passed in to the plugin.", app)
    app.addSidePanel('CAD Chat AI', () => {
        const div = document.createElement('div');

        const chatUI = document.createElement('div');
        try {
            div.appendChild(chatUI);
            window.conversation = new ConversationUI(chatUI, app);
        } catch (error) {
            console.error("Error initializing ConversationUI:", error);
            const errorMessage = document.createElement('p');
            errorMessage.textContent = "Failed to load the chat interface. Please check the console for details.";
            div.appendChild(errorMessage);
        }


        return div;
    });

};





class ConversationUI {
    constructor(container, app) {
        this.app = app;
        this.apiKey = '';
        this.openAiClient = null;
        this.debugEnabled = true;
        this.debugSeq = 1;


        this.container = container;
        this.messages = [];
        this.nextMsgId = 1;
        this.modelId = "gpt-4o-mini";
        this.toolSpecs = this.setupTools();
        this.initUI();
    }

    getSystemPrompt() {
        return `${prompts.system}
For any custom sketch creation or editing, prefer the upsert_sketch tool.
Sketch format:
- points: [{ id, x, y, fixed? }]
- geometries: [{ id, type, points, construction? }]
  - "line": [p0, p1]
  - "circle": [center, radiusPoint]
  - "arc": [center, startPoint, endPoint]
  - "bezier": [anchor0, handle0, handle1, anchor1, ...] with cubic chain length 3n+1
- constraints: [{ id, type, points, value?, displayStyle?, labelX?, labelY? }]
  - "━" horizontal: [p0, p1]
  - "│" vertical: [p0, p1]
  - "⟺" distance: [p0, p1], value
  - "⇌" equal distance/radius: [a0, a1, b0, b1]
  - "∥" parallel: [a0, a1, b0, b1]
  - "⟂" perpendicular/tangent: [a0, a1, b0, b1]
  - "∠" angle: [a0, a1, b0, b1], value (degrees)
  - "≡" coincident: [p0, p1]
  - "⏛" point on line: [lineA, lineB, point]
  - "⋯" midpoint: [a, b, midpoint]
  - "⏚" fixed/ground: [point]
Use integer IDs and ensure geometries/constraints reference existing point IDs.
Do not add fixed/ground constraints unless the user explicitly asks for anchored points.
By default this tool ignores "⏚" constraints to avoid accidentally fixing all points.
Prefer center-based constraints: include a center point at (0,0) and constrain geometry to it when appropriate.
When the user specifies measurements, include dimensional constraints (especially "⟺" and "∠") with explicit numeric values.
For multi-step modeling requests, continue calling tools until the requested model edits are complete before giving a final text-only response.
For numeric inputs, pass plain numbers when possible; numeric strings are also accepted.`;
    }

    getSpecialToolNames() {
        return new Set(['upsert_sketch', 'dump_screenshot', 'dump_part_history', 'delete_feature', 'update_feature', 'modify_feature']);
    }

    debugLog(label, payload = null) {
        if (!this.debugEnabled) return;
        const seq = this.debugSeq++;
        const prefix = `[CAD-CHAT][${seq}] ${label}`;
        try {
            if (payload == null) {
                console.log(prefix);
                return;
            }
            if (typeof console.groupCollapsed === 'function') {
                console.groupCollapsed(prefix);
                console.log(payload);
                console.groupEnd();
                return;
            }
            console.log(prefix, payload);
        } catch {
            // no-op: logging must never break chat flow
        }
    }

    previewText(value, maxLen = 240) {
        const raw = String(value ?? '');
        return raw.length > maxLen ? `${raw.slice(0, maxLen)}...` : raw;
    }

    summarizeApiMessages(messages) {
        const list = Array.isArray(messages) ? messages : [];
        return list.map((m, idx) => {
            const content = m?.content;
            let preview = '';
            if (typeof content === 'string') {
                preview = this.previewText(content);
            } else if (Array.isArray(content)) {
                preview = this.previewText(
                    content.map((p) => {
                        if (p?.type === 'text') return p.text || '';
                        if (p?.type === 'image_url') return '[image_url]';
                        return `[${p?.type || 'part'}]`;
                    }).join(' ')
                );
            } else if (content != null) {
                preview = this.previewText(JSON.stringify(content));
            }
            return {
                index: idx,
                role: m?.role || null,
                tool_call_id: m?.tool_call_id || null,
                tool_calls: Array.isArray(m?.tool_calls) ? m.tool_calls.map((tc) => ({
                    id: tc?.id || null,
                    name: tc?.function?.name || null,
                })) : [],
                preview,
            };
        });
    }

    findOrphanToolMessages(messages) {
        const pending = new Set();
        const issues = [];
        for (let i = 0; i < (messages?.length || 0); i += 1) {
            const m = messages[i] || {};
            if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                    if (tc?.id) pending.add(tc.id);
                }
                continue;
            }
            if (m.role === 'tool') {
                const id = m.tool_call_id || null;
                if (!id || !pending.has(id)) {
                    issues.push({ index: i, role: 'tool', tool_call_id: id });
                } else {
                    pending.delete(id);
                }
            }
        }
        return issues;
    }

    selectToolsForMessage(userMessage, allTools = this.toolSpecs, mode = 'normal') {
        const tools = Array.isArray(allTools) ? allTools : [];
        if (!tools.length) return [];

        const specialNames = this.getSpecialToolNames();
        const specials = tools.filter(t => specialNames.has(t?.function?.name));
        const dynamic = tools.filter(t => !specialNames.has(t?.function?.name));

        const dedupeByName = (arr) => {
            const out = [];
            const seen = new Set();
            for (const t of arr) {
                const name = t?.function?.name;
                if (!name || seen.has(name)) continue;
                seen.add(name);
                out.push(t);
            }
            return out;
        };

        if (mode === 'compact') {
            const preferredOrder = new Set([
                'P_CU', 'P_CY', 'P_CO', 'P_S', 'P_T', 'P_PY',
                'S', 'SP', 'E', 'B', 'F', 'CH', 'R', 'SW', 'M', 'H',
                'PATLIN', 'PATRAD', 'XFORM', 'LOFT', 'TU', 'O_S', 'O_F'
            ]);
            const compact = [];
            for (const t of dynamic) {
                if (preferredOrder.has(t?.function?.name)) compact.push(t);
            }
            for (const t of dynamic) {
                if (compact.includes(t)) continue;
                compact.push(t);
                if (compact.length >= 16) break;
            }
            return dedupeByName([...compact.slice(0, 16), ...specials]);
        }

        const raw = String(userMessage || '').toLowerCase();
        const tokens = Array.from(new Set(raw.split(/[^a-z0-9]+/g).filter(w => w.length >= 3)));
        const matched = [];
        for (const t of dynamic) {
            const name = String(t?.function?.name || '').toLowerCase();
            const desc = String(t?.function?.description || '').toLowerCase();
            if (tokens.some(tok => name.includes(tok) || desc.includes(tok))) {
                matched.push(t);
            }
        }

        const selected = [];
        for (const t of matched) {
            selected.push(t);
            if (selected.length >= 24) break;
        }
        for (const t of dynamic) {
            if (selected.includes(t)) continue;
            selected.push(t);
            if (selected.length >= 14) break;
        }

        return dedupeByName([...selected, ...specials]);
    }

    extractFailedGeneration(error) {
        const candidates = [
            error?.error,
            error?.response?.error,
            error?.body?.error,
            error?.cause?.error,
            error?.cause,
        ];
        for (const candidate of candidates) {
            if (candidate && typeof candidate === 'object' && candidate.failed_generation) {
                return String(candidate.failed_generation);
            }
        }
        return '';
    }

    isToolCallGenerationError(error) {
        const status = Number(error?.status || error?.response?.status || 0);
        const msg = String(error?.message || '');
        if (status !== 400) return false;
        return /failed to call a function/i.test(msg) || /failed_generation/i.test(msg);
    }

    parseNumericLike(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : value;
        if (typeof value !== 'string') return value;
        const raw = value.trim();
        if (!raw) return value;
        const normalized = raw.replace(/,/g, '');
        const maybe = Number(normalized);
        return Number.isFinite(maybe) ? maybe : value;
    }

    coerceArgsForSchema(argsObj, schema) {
        if (!argsObj || typeof argsObj !== 'object' || !schema || typeof schema !== 'object') return argsObj;
        const out = { ...argsObj };
        for (const key of Object.keys(schema)) {
            if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
            const def = schema[key] || {};
            const t = String(def?.type || '');
            const val = out[key];
            if (t === 'number') {
                out[key] = this.parseNumericLike(val);
                continue;
            }
            if (t === 'vec3' && Array.isArray(val)) {
                out[key] = val.map(v => this.parseNumericLike(v));
                continue;
            }
            if (t === 'transform' && val && typeof val === 'object') {
                const tr = { ...val };
                if (Array.isArray(tr.position)) tr.position = tr.position.map(v => this.parseNumericLike(v));
                if (Array.isArray(tr.rotationEuler)) tr.rotationEuler = tr.rotationEuler.map(v => this.parseNumericLike(v));
                if (Array.isArray(tr.scale)) tr.scale = tr.scale.map(v => this.parseNumericLike(v));
                out[key] = tr;
                continue;
            }
            if (t === 'boolean_operation' && val && typeof val === 'object') {
                const bo = { ...val };
                if (Object.prototype.hasOwnProperty.call(bo, 'biasDistance')) bo.biasDistance = this.parseNumericLike(bo.biasDistance);
                if (Object.prototype.hasOwnProperty.call(bo, 'offsetDistance')) bo.offsetDistance = this.parseNumericLike(bo.offsetDistance);
                out[key] = bo;
                continue;
            }
        }
        return out;
    }

    createOpenAIClient(apiKey) {
        if (!apiKey) return null;
        return new openai({
            apiKey,
            dangerouslyAllowBrowser: true,
        });
    }

    promptForApiKeyDialog(initialValue = '') {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:16px;';

            const panel = document.createElement('div');
            panel.style.cssText = 'width:min(520px,95vw);background:#1f1f1f;color:#f2f2f2;border:1px solid #3a3a3a;border-radius:10px;padding:14px;box-shadow:0 14px 44px rgba(0,0,0,0.45);';

            const title = document.createElement('div');
            title.textContent = 'OpenAI API Key';
            title.style.cssText = 'font-weight:600;margin-bottom:10px;';

            const input = document.createElement('input');
            input.type = 'password';
            input.placeholder = 'sk-...';
            input.value = initialValue || '';
            input.style.cssText = 'width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #555;background:#111;color:#f2f2f2;';

            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.cssText = 'padding:8px 12px;border:1px solid #555;background:#2a2a2a;color:#f2f2f2;border-radius:6px;cursor:pointer;';

            const saveBtn = document.createElement('button');
            saveBtn.type = 'button';
            saveBtn.textContent = 'Save';
            saveBtn.style.cssText = 'padding:8px 12px;border:1px solid #2d6cdf;background:#2d6cdf;color:white;border-radius:6px;cursor:pointer;';

            const close = (value) => {
                try { overlay.remove(); } catch { }
                resolve(value);
            };

            cancelBtn.addEventListener('click', () => close(null));
            saveBtn.addEventListener('click', () => close(input.value));
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close(null);
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    close(input.value);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    close(null);
                }
            });

            row.appendChild(cancelBtn);
            row.appendChild(saveBtn);
            panel.appendChild(title);
            panel.appendChild(input);
            panel.appendChild(row);
            overlay.appendChild(panel);
            document.body.appendChild(overlay);
            setTimeout(() => {
                try { input.focus(); input.select(); } catch { }
            }, 0);
        });
    }

    async promptForApiKey() {
        const entered = await this.promptForApiKeyDialog(this.apiKey || '');
        if (entered == null) return false;
        this.apiKey = String(entered || '').trim();
        this.openAiClient = this.createOpenAIClient(this.apiKey);
        return !!this.openAiClient;
    }

    initUI() {
        // Controls row
        this.controlsBar = document.createElement('div');
        this.controlsBar.className = 'chat-controls';
        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.textContent = 'Reset';
        resetBtn.addEventListener('click', () => {
            const ok = confirm('Reset conversation? This clears all messages.');
            if (ok) this.resetConversation();
        });
        this.controlsBar.appendChild(resetBtn);

        const setKeyBtn = document.createElement('button');
        setKeyBtn.type = 'button';
        setKeyBtn.textContent = 'Set API Key';
        setKeyBtn.title = 'Set or replace OpenAI API key';
        setKeyBtn.addEventListener('click', async () => {
            await this.promptForApiKey();
        });
        this.controlsBar.appendChild(setKeyBtn);

        // Screenshot button
        const screenshotBtn = document.createElement('button');
        screenshotBtn.type = 'button';
        screenshotBtn.textContent = '📸 Screenshot';
        screenshotBtn.title = 'Capture viewport and attach to chat';
        screenshotBtn.addEventListener('click', async () => {
            try {
                await this.dumpScreenshot({ sender: 'user', altText: 'User Screenshot' });
            } catch (e) {
                console.error('Screenshot failed:', e);
                this.addMessage('assistant', 'Failed to capture screenshot.');
            }
        });
        this.controlsBar.appendChild(screenshotBtn);

        this.container.appendChild(this.controlsBar);

        this.messageList = document.createElement('div');
        this.messageList.className = 'message-list';
        this.container.appendChild(this.messageList);

        this.inputForm = document.createElement('form');
        this.inputForm.className = 'input-form';
        this.container.appendChild(this.inputForm);

        this.inputField = document.createElement('input');
        this.inputField.type = 'text';
        this.inputField.placeholder = 'Type your message...';
        this.inputForm.appendChild(this.inputField);

        this.sendButton = document.createElement('button');
        this.sendButton.type = 'submit';
        this.sendButton.textContent = 'Send';
        this.inputForm.appendChild(this.sendButton);

        this.inputForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const message = this.inputField.value.trim();
            if (message) {
                this.debugLog('ui.submit', { message });
                this.addMessage('user', message);
                this.sendMessage(message);
                this.inputField.value = '';
            }
        });

        // add the elements to the container
        this.container.appendChild(this.messageList);
        this.container.appendChild(this.inputForm);


        document.head.appendChild(style);

        // Add a welcome message from the assistant
        this.addMessage('assistant', 'Hello! I am your CAD Chat AI. How can I assist you with your 3D modeling needs today?');
        queueMicrotask(() => { void this.promptForApiKey(); });

    }

    addMessage(sender, text) {
        const messageElement = document.createElement('div');
        messageElement.className = `message ${sender}`;
        messageElement.textContent = text;
        const id = this.nextMsgId++;
        messageElement.dataset.msgId = String(id);
        // attach delete button
        messageElement.appendChild(this.createDeleteButton(id, messageElement));
        this.messageList.appendChild(messageElement);
        this.messages.push({ id, sender, text });
        this.debugLog('ui.addMessage', { id, sender, textPreview: this.previewText(text) });
        // keep view scrolled to latest
        this.messageList.scrollTop = this.messageList.scrollHeight;
    }

    addToolCallMessage(toolCall) {
        const wrapper = document.createElement('div');
        wrapper.className = 'message toolCall assistant';

        const title = document.createElement('div');
        title.className = 'toolcall-title';
        title.textContent = `Tool Call: ${toolCall.function?.name ?? 'unknown'}`;
        wrapper.appendChild(title);

        const pre = document.createElement('pre');
        pre.className = 'toolcall-json';
        let jsonText = '';
        try {
            const argsStr = toolCall.function?.arguments ?? '{}';
            const parsed = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr;
            jsonText = JSON.stringify(parsed, null, 2);
        } catch (e) {
            // Fallback to raw content if parsing fails
            jsonText = String(toolCall.function?.arguments ?? '');
        }
        pre.textContent = jsonText;
        wrapper.appendChild(pre);

        const id = this.nextMsgId++;
        wrapper.dataset.msgId = String(id);
        // attach delete button
        wrapper.appendChild(this.createDeleteButton(id, wrapper));
        this.messageList.appendChild(wrapper);
        // Keep tool-call rows in UI only. Do not store them as plain assistant text in model history.
        this.debugLog('ui.addToolCallMessage', {
            id,
            tool_call_id: toolCall?.id || null,
            function: toolCall?.function?.name || null,
            arguments: toolCall?.function?.arguments || null,
        });
        this.messageList.scrollTop = this.messageList.scrollHeight;
    }

    // Add a tool result (structured) message for the UI and model
    addToolResultMessage(toolCall, resultText) {
        const wrapper = document.createElement('div');
        wrapper.className = 'message toolCall assistant';

        const title = document.createElement('div');
        title.className = 'toolcall-title';
        title.textContent = `Tool Result: ${toolCall.function?.name ?? 'unknown'}`;
        wrapper.appendChild(title);

        const pre = document.createElement('pre');
        pre.className = 'toolcall-json';
        pre.textContent = typeof resultText === 'string' ? resultText : JSON.stringify(resultText ?? '', null, 2);
        wrapper.appendChild(pre);

        const id = this.nextMsgId++;
        wrapper.dataset.msgId = String(id);
        // attach delete button
        wrapper.appendChild(this.createDeleteButton(id, wrapper));
        this.messageList.appendChild(wrapper);
        this.messageList.scrollTop = this.messageList.scrollHeight;

        const toolMsg = {
            id,
            sender: 'tool',
            tool_call_id: toolCall.id || toolCall?.function?.name || String(id),
            text: typeof resultText === 'string' ? resultText : JSON.stringify(resultText ?? '')
        };
        // Keep tool-result rows in UI only. Tool messages are stitched explicitly per follow-up call.
        this.debugLog('ui.addToolResultMessage', {
            id,
            tool_call_id: toolMsg.tool_call_id,
            function: toolCall?.function?.name || null,
            resultPreview: this.previewText(toolMsg.text),
        });
        return toolMsg;
    }

    // Add an image message (e.g., screenshots) to the conversation UI
    // Per requirements, all image messages are marked as user messages.
    addImageMessage(_senderIgnored, dataUrl, altText = 'Screenshot') {
        const sender = 'user';
        const wrapper = document.createElement('div');
        wrapper.className = `message ${sender}`;

        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = altText;
        img.className = 'message-image';
        wrapper.appendChild(img);

        if (altText) {
            const cap = document.createElement('div');
            cap.className = 'message-caption';
            cap.textContent = altText;
            wrapper.appendChild(cap);
        }

        const id = this.nextMsgId++;
        wrapper.dataset.msgId = String(id);
        // attach delete button
        wrapper.appendChild(this.createDeleteButton(id, wrapper));
        this.messageList.appendChild(wrapper);
        // Preserve conversational context for the model and include the image for the API
        this.messages.push({ id, sender, text: altText || '[Screenshot attached]', image: dataUrl, altText });
        this.debugLog('ui.addImageMessage', { id, sender, altText: altText || '[Screenshot attached]' });
        this.messageList.scrollTop = this.messageList.scrollHeight;
    }

    // Convert internal messages to Chat Completions format, including images
    buildChatMessages(modelId) {
        const supportsImages = this.supportsImageParts(modelId);
        let theMessages = this.messages.map(m => {
            // Tool result messages are forwarded with the tool role
            if (m.sender === 'tool') {
                return { role: 'tool', tool_call_id: m.tool_call_id, content: m.text || '' };
            }
            // Coerce any image-bearing message to role:user for API compatibility
            const role = m.image ? 'user' : (m.sender === 'user' ? 'user' : 'assistant');
            // Only include image parts if supported AND role is user
            if (m.image && supportsImages && role === 'user') {
                const parts = [];
                const textLabel = (m.text && String(m.text).trim()) ? String(m.text) : (m.altText || 'Screenshot');
                if (textLabel) parts.push({ type: 'text', text: textLabel });
                // Chat Completions image part format
                parts.push({ type: 'image_url', image_url: { url: m.image } });
                return { role, content: parts };
            }
            // If there's an image but it's not supported by the model/role, fall back to text
            if (m.image && (!supportsImages || role !== 'user')) {
                const textLabel = (m.text && String(m.text).trim()) ? String(m.text) : (m.altText || 'Screenshot');
                return { role, content: textLabel };
            }
            // Plain text message
            return { role, content: m.text || '' };
        });
        console.log("Built chat messages for API:", theMessages);
        return theMessages;
    }

    // Heuristic check if the model likely supports image parts in Chat Completions
    supportsImageParts(modelId) {
        const id = String(modelId || '').toLowerCase();
        const hints = [
            'vision', 'gpt-4o', 'gpt-4.1', 'omni', 'o3', 'o4', 'vl'
        ];
        return hints.some(h => id.includes(h));
    }

    // Utility to create a per-message delete button
    createDeleteButton(id, wrapperEl) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'delete-btn';
        btn.title = 'Delete message';
        btn.textContent = '×';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.deleteMessageById(id, wrapperEl);
        });
        return btn;
    }

    deleteMessageById(id, wrapperEl) {
        const idx = this.messages.findIndex(m => m.id === id);
        if (idx !== -1) this.messages.splice(idx, 1);
        if (wrapperEl && wrapperEl.parentNode === this.messageList) {
            this.messageList.removeChild(wrapperEl);
        }
    }

    resetConversation() {
        // Clear model-side and UI-side state
        this.messages = [];
        this.nextMsgId = 1;
        while (this.messageList.firstChild) this.messageList.removeChild(this.messageList.firstChild);
        // Add a fresh welcome
        this.addMessage('assistant', 'Conversation reset. How can I help next?');
        this.debugLog('conversation.reset');
    }

    async sendMessage(message, options = {}) {
        try {
            this.debugLog('sendMessage.start', {
                message,
                options,
                localMessageCount: this.messages.length,
            });

            if (!this.openAiClient) {
                const ok = await this.promptForApiKey();
                if (!ok || !this.openAiClient) return;
            }

            const model = this.modelId;
            const activeTools = Array.isArray(options.activeTools) && options.activeTools.length
                ? options.activeTools
                : this.selectToolsForMessage(message, this.toolSpecs, options.toolMode || 'normal');
            const payloadMessages = [
                { role: "system", content: this.getSystemPrompt() },
                // insert the current feature history in to the conversation.
                { role: "user", content: `Here is the part history. This is always the latest and greatest: ${await this?.app?.viewer?.partHistory?.toJSON()}` },
                ...this.buildChatMessages(model)
            ];
            const orphanTools = this.findOrphanToolMessages(payloadMessages);
            if (orphanTools.length) {
                this.debugLog('sendMessage.orphanToolMessages', { issues: orphanTools });
            }
            console.log("Built chat messages for API:", payloadMessages);
            console.log("Available tools for this model:", this.toolSpecs);
            console.log("Active tool subset:", activeTools.map(t => t?.function?.name).filter(Boolean));
            this.debugLog('sendMessage.request', {
                model,
                activeToolNames: activeTools.map(t => t?.function?.name).filter(Boolean),
                payloadSummary: this.summarizeApiMessages(payloadMessages),
            });

            const response = await this.openAiClient.chat.completions.create({
                model,
                tools: activeTools,
                tool_choice: "auto",
                parallel_tool_calls: false,
                messages: payloadMessages,
            });

            const responseMessage = response.choices[0].message;
            this.debugLog('sendMessage.response', {
                finishReason: response?.choices?.[0]?.finish_reason || null,
                usage: response?.usage || null,
                message: {
                    role: responseMessage?.role || null,
                    contentPreview: this.previewText(responseMessage?.content || ''),
                    toolCalls: Array.isArray(responseMessage?.tool_calls) ? responseMessage.tool_calls.map((tc) => ({
                        id: tc?.id || null,
                        name: tc?.function?.name || null,
                        arguments: tc?.function?.arguments || null,
                    })) : [],
                },
            });
            if (responseMessage?.content) {
                this.addMessage('assistant', responseMessage.content);
            }

            await this.processResponse(responseMessage, activeTools, 0);

        } catch (error) {
            console.error("Error sending message to OpenAI:", error);
            this.debugLog('sendMessage.error', {
                message,
                status: Number(error?.status || error?.response?.status || 0),
                error: error?.message || String(error),
            });
            const status = Number(error?.status || error?.response?.status || 0);
            const msg = String(error?.message || '');
            if (status === 401 || /invalid api key/i.test(msg)) {
                this.openAiClient = null;
                this.addMessage('assistant', 'Authentication failed (401). Set API Key and try again.');
                return;
            }
            if (this.isToolCallGenerationError(error)) {
                const failedGeneration = this.extractFailedGeneration(error);
                if (!options._retriedCompactTools) {
                    const compactTools = this.selectToolsForMessage(message, this.toolSpecs, 'compact');
                    this.addMessage('assistant', `Tool-calling failed with model output formatting. Retrying with a compact toolset (${compactTools.length} tools)...`);
                    await this.sendMessage(message, { _retriedCompactTools: true, toolMode: 'compact', activeTools: compactTools });
                    return;
                }
                this.addMessage('assistant', `Tool-calling failed (400). ${failedGeneration ? `failed_generation: ${failedGeneration}` : msg}`);
                return;
            }
            this.addMessage('assistant', "Sorry, there was an error processing your request.");
        }
    }


    async processResponse(responseMessage, activeTools = this.toolSpecs, depth = 0) {
        if (depth > 8) {
            this.debugLog('processResponse.maxDepthReached', { depth });
            this.addMessage('assistant', 'Stopping tool loop after reaching safety depth limit.');
            return;
        }
        const model = this.modelId;
        const toolCalls = responseMessage.tool_calls ?? [];
        console.log("Tool calls from the message:", toolCalls);
        this.debugLog('processResponse.start', {
            depth,
            responseContentPreview: this.previewText(responseMessage?.content || ''),
            toolCalls: Array.isArray(toolCalls) ? toolCalls.map((tc) => ({
                id: tc?.id || null,
                name: tc?.function?.name || null,
                arguments: tc?.function?.arguments || null,
            })) : [],
        });

        if (!toolCalls.length) return;

        // Execute tools, collect structured results
        const toolResults = [];
        for (const toolCall of toolCalls) {
            try {
                console.log("Processing tool call:", toolCall);
                this.debugLog('processResponse.toolCall.begin', {
                    id: toolCall?.id || null,
                    name: toolCall?.function?.name || null,
                    arguments: toolCall?.function?.arguments || null,
                });
                this.addToolCallMessage(toolCall);
                const resultText = await this.callTool(toolCall);
                this.debugLog('processResponse.toolCall.result', {
                    id: toolCall?.id || null,
                    name: toolCall?.function?.name || null,
                    resultPreview: this.previewText(resultText),
                });
                const msg = this.addToolResultMessage(toolCall, resultText ?? 'OK');
                toolResults.push(msg);
            } catch (error) {
                console.error("Error processing tool call:", error);
                this.debugLog('processResponse.toolCall.error', {
                    id: toolCall?.id || null,
                    name: toolCall?.function?.name || null,
                    error: error?.message || String(error),
                });
                const errText = `Tool '${toolCall?.function?.name || 'unknown'}' failed: ${error?.message || error}`;
                const msg = this.addToolResultMessage(toolCall, errText);
                toolResults.push(msg);
            }
        }

        try {
            // Build a follow-up request including the original assistant tool_call message
            const baseHistory = this.buildChatMessages(model);
            const ids = new Set(toolResults.map(m => m.tool_call_id));
            // Remove these specific tool messages to re-insert them after the assistant tool_call message
            const historyWithoutNewToolMsgs = baseHistory.filter(m => !(m.role === 'tool' && ids.has(m.tool_call_id)));

            const payloadMessages = [
                { role: 'system', content: this.getSystemPrompt() },
                { role: 'user', content: `Here is the part history. This is always the latest and greatest: ${await this?.app?.viewer?.partHistory?.toJSON()}` },
                ...historyWithoutNewToolMsgs,
                { role: 'assistant', content: responseMessage.content || undefined, tool_calls: responseMessage.tool_calls },
                // Re-append the tool results in the correct order
                ...toolResults.map(m => ({ role: 'tool', tool_call_id: m.tool_call_id, content: m.text || '' })),
            ];

            console.log('Follow-up payload after tools:', payloadMessages);
            const orphanTools = this.findOrphanToolMessages(payloadMessages);
            if (orphanTools.length) {
                this.debugLog('processResponse.followup.orphanToolMessages', { issues: orphanTools });
            }
            this.debugLog('processResponse.followup.request', {
                model,
                payloadSummary: this.summarizeApiMessages(payloadMessages),
            });

            const followup = await this.openAiClient.chat.completions.create({
                model,
                tools: activeTools,
                // Allow additional tool calls so multi-step requests can continue.
                tool_choice: "auto",
                parallel_tool_calls: false,
                messages: payloadMessages,
            });

            const msg = followup.choices?.[0]?.message || {};
            this.debugLog('processResponse.followup.response', {
                finishReason: followup?.choices?.[0]?.finish_reason || null,
                usage: followup?.usage || null,
                message: {
                    role: msg?.role || null,
                    contentPreview: this.previewText(msg?.content || ''),
                    toolCalls: Array.isArray(msg?.tool_calls) ? msg.tool_calls.map((tc) => ({
                        id: tc?.id || null,
                        name: tc?.function?.name || null,
                        arguments: tc?.function?.arguments || null,
                    })) : [],
                },
            });
            this.addMessage('assistant', msg.content || '');
            // Process any further tool calls recursively
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
                await this.processResponse(msg, activeTools, depth + 1);
            }
        } catch (e) {
            console.error('Follow-up after tools failed:', e);
            this.debugLog('processResponse.followup.error', {
                error: e?.message || String(e),
            });
            this.addMessage('assistant', `Failed to complete after tool calls: ${e?.message || e}`);
        }
    }




    sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

    async dumpScreenshot({ sender = 'user', altText = 'CAD Screenshot' } = {}) {
        await this.sleep(2000);
        this.app.viewer.zoomToFit(1.2);
        await this.sleep(2000);
        const image = await this.app.viewer.renderer.domElement.toDataURL();

        // Add screenshot directly into the conversation UI
        this.addImageMessage(sender, image, altText);
        return image;
    }


    // Dump current part history JSON to the conversation
    async dumpPartHistory() {
        try {
            const ph = this?.app?.viewer?.partHistory;
            if (!ph) {
                this.addMessage('assistant', 'Part history is not available.');
                return null;
            }
            const json = await (typeof ph.toJSON === 'function' ? ph.toJSON() : null);
            const asString = typeof json === 'string' ? json : JSON.stringify(json ?? {}, null, 2);
            this.addMessage('assistant', `Current part history (JSON):\n${asString}`);
            return asString;
        } catch (e) {
            console.error('dumpPartHistory failed:', e);
            this.addMessage('assistant', `Failed to dump part history: ${e?.message || e}`);
            return null;
        }
    }

    // Delete a feature by ID from the part history
    async deleteFeature(args) {
        try {
            let parsed = args;
            if (typeof args === 'string') {
                try { parsed = JSON.parse(args || '{}'); } catch { parsed = {}; }
            }
            const featureId = parsed?.featureId || parsed?.featureID || parsed?.id;
            if (!featureId) {
                this.addMessage('assistant', 'delete_feature requires a featureId.');
                return false;
            }
            const ph = this?.app?.viewer?.partHistory;
            if (!ph || typeof ph.removeFeature !== 'function') {
                this.addMessage('assistant', 'Part history or removeFeature is unavailable.');
                return false;
            }
            await ph.removeFeature(featureId);
            // Ensure downstream artifacts are updated
            if (typeof ph.runHistory === 'function') {
                await ph.runHistory();
            }
            this.addMessage('assistant', `Deleted feature: ${featureId}`);
            // Provide a visual confirmation
            try {
                await this.dumpScreenshot({ sender: 'user', altText: `After deleting ${featureId}` });
            } catch (_) { /* non-fatal */ }
            return true;
        } catch (e) {
            console.error('deleteFeature failed:', e);
            this.addMessage('assistant', `Failed to delete feature: ${e?.message || e}`);
            return false;
        }
    }

    // Modify an existing feature's input params and re-run history
    async modifyFeature(args) {
        try {
            let parsed = args;
            if (typeof args === 'string') {
                try { parsed = JSON.parse(args || '{}'); } catch { parsed = {}; }
            }
            const featureId = parsed?.featureId || parsed?.featureID || parsed?.id;
            const params = parsed?.params || parsed?.updates || {};
            if (!featureId || typeof params !== 'object') {
                const msg = 'modify_feature requires featureId and params object.';
                this.addMessage('assistant', msg);
                return { ok: false, error: msg };
            }
            const ph = this?.app?.viewer?.partHistory;
            if (!ph || !Array.isArray(ph.features)) {
                const msg = 'Part history not available to modify feature.';
                this.addMessage('assistant', msg);
                return { ok: false, error: msg };
            }
            const feat = ph.features.find(f => f?.inputParams?.featureID === featureId);
            if (!feat) {
                const msg = `Feature not found: ${featureId}`;
                this.addMessage('assistant', msg);
                return { ok: false, error: msg };
            }
            // Merge new params into existing inputParams, coercing numeric-like values.
            const FeatureClass = ph?.featureRegistry?.getSafe?.(feat.type) || null;
            const schema = FeatureClass?.inputParamsSchema || null;
            const coercedParams = this.coerceArgsForSchema(params, schema);
            Object.assign(feat.inputParams, coercedParams);
            if (typeof ph.runHistory === 'function') {
                await ph.runHistory();
            }
            this.addMessage('assistant', `Modified feature ${featureId} with params: ${JSON.stringify(coercedParams, null, 2)}`);
            try { await this.dumpScreenshot({ sender: 'user', altText: `After modifying ${featureId}` }); } catch (_) { }
            return { ok: true, featureId, params: coercedParams };
        } catch (e) {
            console.error('modifyFeature failed:', e);
            this.addMessage('assistant', `Failed to modify feature: ${e?.message || e}`);
            return { ok: false, error: e?.message || String(e) };
        }
    }

    toFiniteNumber(value, fallback = null) {
        const parsed = this.parseNumericLike(value);
        return (typeof parsed === 'number' && Number.isFinite(parsed)) ? parsed : fallback;
    }

    normalizeConstraintType(rawType) {
        const raw = String(rawType ?? '').trim();
        if (!raw) return '';
        const key = raw.toLowerCase();
        const map = {
            horizontal: '━',
            h: '━',
            vertical: '│',
            v: '│',
            distance: '⟺',
            length: '⟺',
            equal: '⇌',
            equal_distance: '⇌',
            equaldistance: '⇌',
            equal_radius: '⇌',
            equalradius: '⇌',
            parallel: '∥',
            perpendicular: '⟂',
            tangent: '⟂',
            angle: '∠',
            coincident: '≡',
            point_on_line: '⏛',
            pointonline: '⏛',
            collinear: '⏛',
            colinear: '⏛',
            midpoint: '⋯',
            mid_point: '⋯',
            fixed: '⏚',
            ground: '⏚',
            lock: '⏚',
            '⋱': '⋯',
        };
        if (Object.prototype.hasOwnProperty.call(map, raw)) return map[raw];
        if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
        return raw;
    }

    buildSketchPayload(inputSketch, options = {}) {
        const sketchInput = (inputSketch && typeof inputSketch === 'object') ? inputSketch : {};
        const allowGround = options?.allowGround === true;
        const preferCenterConstraints = options?.preferCenterConstraints !== false;
        const centerTolerance = Math.max(1e-9, Math.abs(this.toFiniteNumber(options?.centerTolerance, 1e-6)));
        const warnings = [];
        const counters = { point: 0, geometry: 0, constraint: 0 };
        const expectedConstraintPoints = {
            '━': 2, '│': 2, '⟺': 2, '⇌': 4, '∥': 4, '⟂': 4, '∠': 4, '≡': 2, '⏛': 3, '⋯': 3, '⏚': 1,
        };
        const minGeometryPoints = { line: 2, circle: 2, arc: 3, bezier: 4 };
        const allowedGeometryTypes = new Set(['line', 'circle', 'arc', 'bezier']);
        const allowedConstraintTypes = new Set(Object.keys(expectedConstraintPoints));

        const allocateId = (candidate, used, counterKey) => {
            let id = this.toFiniteNumber(candidate, null);
            if (id != null) id = Math.floor(id);
            if (id != null && id < 0) id = null;
            if (id == null || used.has(id)) {
                while (used.has(counters[counterKey])) counters[counterKey] += 1;
                id = counters[counterKey];
            }
            used.add(id);
            if (id >= counters[counterKey]) counters[counterKey] = id + 1;
            return id;
        };

        const usedPointIds = new Set();
        const points = [];
        const rawPoints = Array.isArray(sketchInput?.points) ? sketchInput.points : [];
        for (const rawPoint of rawPoints) {
            if (!rawPoint || typeof rawPoint !== 'object') continue;
            const id = allocateId(rawPoint.id, usedPointIds, 'point');
            const x = this.toFiniteNumber(rawPoint.x, 0);
            const y = this.toFiniteNumber(rawPoint.y, 0);
            points.push({ id, x, y, fixed: rawPoint.fixed === true });
        }
        if (!points.length) {
            const id = allocateId(0, usedPointIds, 'point');
            points.push({ id, x: 0, y: 0, fixed: false });
            warnings.push('No valid points were provided. Inserted a default origin point.');
        }

        let centerPoint = points.find((p) => Math.abs(p.x) <= centerTolerance && Math.abs(p.y) <= centerTolerance) || null;
        if (!centerPoint) {
            const centerId = usedPointIds.has(0) ? allocateId(null, usedPointIds, 'point') : allocateId(0, usedPointIds, 'point');
            centerPoint = { id: centerId, x: 0, y: 0, fixed: false };
            points.push(centerPoint);
            warnings.push(`Inserted center point at (0,0) with id ${centerId} for center-based constraints.`);
        }

        const validPointIds = new Set(points.map((p) => p.id));
        const parsePointRefList = (rawList) => {
            const refs = Array.isArray(rawList) ? rawList : [];
            const out = [];
            for (const raw of refs) {
                if (raw && typeof raw === 'object') {
                    const rawPointId = this.toFiniteNumber(raw?.pointId ?? raw?.id, null);
                    if (rawPointId == null) continue;
                    const pidObj = Math.floor(rawPointId);
                    if (!validPointIds.has(pidObj)) continue;
                    out.push(pidObj);
                    continue;
                }
                const id = this.toFiniteNumber(raw, null);
                if (id == null) continue;
                const pid = Math.floor(id);
                if (!validPointIds.has(pid)) continue;
                out.push(pid);
            }
            return out;
        };

        const usedGeometryIds = new Set();
        const geometries = [];
        const rawGeometries = Array.isArray(sketchInput?.geometries) ? sketchInput.geometries : [];
        for (const rawGeometry of rawGeometries) {
            if (!rawGeometry || typeof rawGeometry !== 'object') continue;
            let type = String(rawGeometry.type ?? '').trim().toLowerCase();
            if (type === 'spline') type = 'bezier';
            if (!allowedGeometryTypes.has(type)) {
                warnings.push(`Skipped geometry with unsupported type "${rawGeometry?.type}".`);
                continue;
            }
            const refs = parsePointRefList(rawGeometry.points);
            const minNeeded = minGeometryPoints[type] || 2;
            if (refs.length < minNeeded) {
                warnings.push(`Skipped ${type} geometry because it had ${refs.length} valid point refs; needs at least ${minNeeded}.`);
                continue;
            }
            const id = allocateId(rawGeometry.id, usedGeometryIds, 'geometry');
            const pointRefs = (type === 'bezier') ? refs : refs.slice(0, minNeeded);
            geometries.push({
                id,
                type,
                points: pointRefs,
                construction: rawGeometry.construction === true,
            });
        }

        const geometryById = new Map(geometries.map((g) => [Number(g.id), g]));
        const appendGeometryRefsAsPoints = (out, rawGeometryRef, constraintType) => {
            const gidNum = this.toFiniteNumber(rawGeometryRef, null);
            if (gidNum == null) return false;
            const geometry = geometryById.get(Math.floor(gidNum));
            if (!geometry || !Array.isArray(geometry.points)) return false;

            // Constraint engine expects point IDs; expand any geometry refs accordingly.
            if (constraintType === '⟺' && (geometry.type === 'circle' || geometry.type === 'arc')) {
                if (geometry.points.length >= 2) {
                    out.push(geometry.points[0], geometry.points[1]);
                    return true;
                }
                return false;
            }

            if (geometry.points.length >= 2) {
                out.push(geometry.points[0], geometry.points[1]);
                return true;
            }
            return false;
        };

        const parseConstraintPointRefs = (rawConstraint, constraintType) => {
            const out = [];
            const refs = Array.isArray(rawConstraint?.points) ? rawConstraint.points : [];

            for (const raw of refs) {
                if (raw && typeof raw === 'object') {
                    const refType = String(raw?.type ?? raw?.kind ?? raw?.refType ?? '').toLowerCase();
                    if (refType.includes('geometry') || refType.includes('curve') || refType.includes('edge') || refType.includes('line') || refType.includes('circle') || refType.includes('arc') || refType.includes('bezier')) {
                        appendGeometryRefsAsPoints(out, raw?.id, constraintType);
                        continue;
                    }
                    const rawPointId = this.toFiniteNumber(raw?.pointId ?? raw?.id, null);
                    if (rawPointId == null) continue;
                    const pidObj = Math.floor(rawPointId);
                    if (!validPointIds.has(pidObj)) continue;
                    out.push(pidObj);
                    continue;
                }

                const pointId = this.toFiniteNumber(raw, null);
                if (pointId != null) {
                    const pid = Math.floor(pointId);
                    if (validPointIds.has(pid)) {
                        out.push(pid);
                        continue;
                    }
                }

                appendGeometryRefsAsPoints(out, raw, constraintType);
            }

            const geometryRefFields = [
                rawConstraint?.geometryId,
                rawConstraint?.geometryID,
                rawConstraint?.geometry,
                rawConstraint?.curveId,
                rawConstraint?.curveID,
                rawConstraint?.curve,
            ];
            for (const field of geometryRefFields) {
                if (field == null) continue;
                appendGeometryRefsAsPoints(out, field, constraintType);
            }

            const geometryRefArrays = [rawConstraint?.geometryIds, rawConstraint?.geometries, rawConstraint?.curves];
            for (const arr of geometryRefArrays) {
                if (!Array.isArray(arr)) continue;
                for (const item of arr) {
                    if (item && typeof item === 'object') {
                        appendGeometryRefsAsPoints(out, item?.id, constraintType);
                    } else {
                        appendGeometryRefsAsPoints(out, item, constraintType);
                    }
                }
            }

            if (constraintType === '⏛' && out.length < 3) {
                const extraPointCandidates = [rawConstraint?.pointId, rawConstraint?.point, rawConstraint?.targetPointId, rawConstraint?.target];
                for (const pRaw of extraPointCandidates) {
                    const pNum = this.toFiniteNumber(pRaw, null);
                    if (pNum == null) continue;
                    const pid = Math.floor(pNum);
                    if (!validPointIds.has(pid)) continue;
                    out.push(pid);
                    if (out.length >= 3) break;
                }
            }

            return out;
        };

        const getPointById = (id) => points.find((p) => Number(p.id) === Number(id)) || null;
        const isRadialPair = (a, b) => {
            for (const g of geometries) {
                if (!g || !Array.isArray(g.points) || g.points.length < 2) continue;
                if (!(g.type === 'circle' || g.type === 'arc')) continue;
                const c = Number(g.points[0]);
                const r = Number(g.points[1]);
                if ((Number(a) === c && Number(b) === r) || (Number(a) === r && Number(b) === c)) {
                    return true;
                }
            }
            return false;
        };

        const inferDistanceValue = (a, b) => {
            const p0 = getPointById(a);
            const p1 = getPointById(b);
            if (!p0 || !p1) return null;
            const d = Math.hypot((Number(p1.x) - Number(p0.x)), (Number(p1.y) - Number(p0.y)));
            return Number.isFinite(d) ? d : null;
        };

        const inferAngleValueDeg = (a, b, c, d) => {
            const p0 = getPointById(a);
            const p1 = getPointById(b);
            const p2 = getPointById(c);
            const p3 = getPointById(d);
            if (!p0 || !p1 || !p2 || !p3) return null;
            const ang1 = Math.atan2(Number(p1.y) - Number(p0.y), Number(p1.x) - Number(p0.x));
            const ang2 = Math.atan2(Number(p3.y) - Number(p2.y), Number(p3.x) - Number(p2.x));
            let deg = (ang1 - ang2) * (180 / Math.PI);
            deg = ((deg % 360) + 360) % 360;
            return Number.isFinite(deg) ? deg : null;
        };

        const usedConstraintIds = new Set();
        const constraints = [];
        const rawConstraints = Array.isArray(sketchInput?.constraints)
            ? sketchInput.constraints
            : (Array.isArray(sketchInput?.dimensions) ? sketchInput.dimensions : []);
        for (const rawConstraint of rawConstraints) {
            if (!rawConstraint || typeof rawConstraint !== 'object') continue;
            const type = this.normalizeConstraintType(rawConstraint.type);
            if (!allowedConstraintTypes.has(type)) {
                warnings.push(`Skipped constraint with unsupported type "${rawConstraint?.type}".`);
                continue;
            }
            if (type === '⏚' && !allowGround) {
                warnings.push('Skipped ground/fixed constraint (⏚). Set allowGround=true to keep anchored points.');
                continue;
            }
            const refs = parseConstraintPointRefs(rawConstraint, type);
            const needed = expectedConstraintPoints[type] || refs.length;
            if (refs.length < needed) {
                warnings.push(`Skipped ${type} constraint because it had ${refs.length} valid point refs; needs ${needed}.`);
                continue;
            }
            const id = allocateId(rawConstraint.id, usedConstraintIds, 'constraint');
            const constraint = {
                id,
                type,
                points: refs.slice(0, needed),
            };
            if (Object.prototype.hasOwnProperty.call(rawConstraint, 'value')) {
                const value = this.toFiniteNumber(rawConstraint.value, null);
                if (value != null) constraint.value = value;
                else if (rawConstraint.value === null) constraint.value = null;
            }
            if (!Object.prototype.hasOwnProperty.call(constraint, 'value')) {
                if (type === '⟺' && constraint.points.length >= 2) {
                    const inferredDistance = inferDistanceValue(constraint.points[0], constraint.points[1]);
                    if (inferredDistance != null) constraint.value = inferredDistance;
                } else if (type === '∠' && constraint.points.length >= 4) {
                    const inferredAngle = inferAngleValueDeg(constraint.points[0], constraint.points[1], constraint.points[2], constraint.points[3]);
                    if (inferredAngle != null) constraint.value = inferredAngle;
                }
            }
            if (Object.prototype.hasOwnProperty.call(rawConstraint, 'labelX')) {
                const labelX = this.toFiniteNumber(rawConstraint.labelX, null);
                if (labelX != null) constraint.labelX = labelX;
            }
            if (Object.prototype.hasOwnProperty.call(rawConstraint, 'labelY')) {
                const labelY = this.toFiniteNumber(rawConstraint.labelY, null);
                if (labelY != null) constraint.labelY = labelY;
            }
            if (typeof rawConstraint.displayStyle === 'string' && rawConstraint.displayStyle.trim()) {
                constraint.displayStyle = rawConstraint.displayStyle.trim();
            } else if (type === '⟺' && constraint.points.length >= 2 && isRadialPair(constraint.points[0], constraint.points[1])) {
                constraint.displayStyle = 'radius';
            }
            constraints.push(constraint);
        }

        if (preferCenterConstraints && centerPoint) {
            const centerId = centerPoint.id;
            const hasPairConstraint = (type, a, b) => constraints.some((c) =>
                c?.type === type
                && Array.isArray(c?.points)
                && c.points.length >= 2
                && (
                    (Number(c.points[0]) === a && Number(c.points[1]) === b)
                    || (Number(c.points[0]) === b && Number(c.points[1]) === a)
                )
            );

            let injected = 0;
            for (const point of points) {
                if (!point || point.id === centerId) continue;

                const nearX = Math.abs(point.x - centerPoint.x) <= centerTolerance;
                const nearY = Math.abs(point.y - centerPoint.y) <= centerTolerance;

                if (nearX && nearY) {
                    if (!hasPairConstraint('≡', centerId, point.id)) {
                        const id = allocateId(null, usedConstraintIds, 'constraint');
                        constraints.push({ id, type: '≡', points: [centerId, point.id] });
                        injected += 1;
                    }
                    continue;
                }

                if (nearX && !hasPairConstraint('│', centerId, point.id)) {
                    const id = allocateId(null, usedConstraintIds, 'constraint');
                    constraints.push({ id, type: '│', points: [centerId, point.id] });
                    injected += 1;
                }

                if (nearY && !hasPairConstraint('━', centerId, point.id)) {
                    const id = allocateId(null, usedConstraintIds, 'constraint');
                    constraints.push({ id, type: '━', points: [centerId, point.id] });
                    injected += 1;
                }
            }

            if (injected > 0) {
                warnings.push(`Added ${injected} center-based constraints using point ${centerId}.`);
            }
        }

        return {
            sketch: { points, geometries, constraints },
            warnings,
        };
    }

    async upsertSketch(args) {
        let parsed = args;
        if (typeof args === 'string') {
            try { parsed = JSON.parse(args || '{}'); } catch { parsed = {}; }
        }
        parsed = (parsed && typeof parsed === 'object') ? parsed : {};

        const partHistory = this?.app?.viewer?.partHistory;
        if (!partHistory) throw new Error('Part history is unavailable.');

        const featureId = parsed?.featureId || parsed?.featureID || parsed?.id || null;
        let feature = null;
        if (featureId) {
            feature = (partHistory.features || []).find((f) => f?.inputParams?.featureID === featureId) || null;
            if (!feature) throw new Error(`Feature not found: ${featureId}`);
            const typeName = String(feature.type || '').toLowerCase();
            if (!(typeName === 'sketch' || typeName === 's' || typeName.includes('sketch'))) {
                throw new Error(`Feature ${featureId} is not a Sketch feature.`);
            }
        } else {
            feature = await partHistory.newFeature('Sketch');
        }

        const sketchInput = (parsed?.sketch && typeof parsed.sketch === 'object')
            ? parsed.sketch
            : parsed;
        const allowGround = parsed?.allowGround === true;
        const preferCenterConstraints = parsed?.preferCenterConstraints !== false;
        const centerTolerance = this.toFiniteNumber(parsed?.centerTolerance, 1e-6);
        const { sketch, warnings } = this.buildSketchPayload(sketchInput, {
            allowGround,
            preferCenterConstraints,
            centerTolerance,
        });

        feature.inputParams = feature.inputParams || {};
        feature.persistentData = feature.persistentData || {};

        const curveResolution = this.toFiniteNumber(parsed?.curveResolution, null);
        if (curveResolution != null) {
            feature.inputParams.curveResolution = Math.max(8, Math.floor(curveResolution));
        } else if (!Number.isFinite(Number(feature?.inputParams?.curveResolution))) {
            feature.inputParams.curveResolution = 64;
        }

        const sketchPlane = parsed?.sketchPlane || parsed?.plane || null;
        if (sketchPlane) feature.inputParams.sketchPlane = sketchPlane;

        feature.persistentData.sketch = sketch;
        await partHistory.runHistory();

        const featureOutId = feature?.inputParams?.featureID || null;
        this.addMessage('assistant', `Upserted sketch in feature ${featureOutId || '(new)'}. Points: ${sketch.points.length}, curves: ${sketch.geometries.length}, constraints: ${sketch.constraints.length}.`);
        try { await this.dumpScreenshot({ sender: 'user', altText: 'After upsert_sketch' }); } catch (_) { }

        return {
            ok: true,
            featureId: featureOutId,
            counts: {
                points: sketch.points.length,
                geometries: sketch.geometries.length,
                constraints: sketch.constraints.length,
            },
            warnings,
        };
    }





    async callTool(toolCall) {
        try {
            this.debugLog('callTool.start', {
                id: toolCall?.id || null,
                name: toolCall?.function?.name || null,
                arguments: toolCall?.function?.arguments || null,
            });

            // add code here to handle the special case tools like 'dump_screenshot', 'dump_part_history', and 'delete_feature' before processing regular feature calls.
            if (toolCall.function.name === 'upsert_sketch') {
                const result = await this.upsertSketch(toolCall.function.arguments);
                this.debugLog('callTool.done', { id: toolCall?.id || null, name: 'upsert_sketch', resultPreview: this.previewText(JSON.stringify(result)) });
                return JSON.stringify(result);
            } else if (toolCall.function.name === 'dump_screenshot') {
                // Pass through optional altText
                let args = {};
                try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch { args = {}; }
                await this.dumpScreenshot({ sender: 'user', altText: args?.altText || 'CAD Screenshot' });
                this.debugLog('callTool.done', { id: toolCall?.id || null, name: 'dump_screenshot', resultPreview: 'ok' });
                return JSON.stringify({ ok: true, screenshot: true, altText: args?.altText || 'CAD Screenshot' });
            } else if (toolCall.function.name === 'dump_part_history') {
                const phJson = await this.dumpPartHistory();
                this.debugLog('callTool.done', { id: toolCall?.id || null, name: 'dump_part_history', resultPreview: this.previewText(phJson || '') });
                return typeof phJson === 'string' ? phJson : JSON.stringify(phJson ?? {});
            } else if (toolCall.function.name === 'delete_feature') {
                const ok = await this.deleteFeature(toolCall.function.arguments);
                let parsed = {};
                try { parsed = JSON.parse(toolCall.function.arguments || '{}'); } catch { }
                const featureId = parsed?.featureId || parsed?.featureID || parsed?.id;
                this.debugLog('callTool.done', { id: toolCall?.id || null, name: 'delete_feature', resultPreview: `ok=${!!ok}, featureId=${featureId || ''}` });
                return JSON.stringify({ ok: !!ok, deleted: featureId });
            } else if (toolCall.function.name === 'update_feature' || toolCall.function.name === 'modify_feature') {
                const result = await this.modifyFeature(toolCall.function.arguments);
                this.debugLog('callTool.done', { id: toolCall?.id || null, name: toolCall.function.name, resultPreview: this.previewText(JSON.stringify(result)) });
                return JSON.stringify(result);
            }









            const partHistory = this.app.viewer.partHistory; // Assuming this is how you access the part history


            console.log("Processing tool call:", toolCall);
            const { name, arguments: args } = toolCall.function;
            console.log(`Calling tool: ${name} with arguments:`, args);

            // fix the name to match the feature short name if necessary by replacing underscores with dots and ensuring it matches the feature registry naming convention
            const featureName = name.replace(/_/g, '.');
            console.log(`Resolved feature name: ${featureName}`);

            const rawArgsObj = JSON.parse(args || '{}');
            const FeatureClass = partHistory?.featureRegistry?.getSafe?.(featureName) || null;
            const featureSchema = FeatureClass?.inputParamsSchema || null;
            const argsObj = this.coerceArgsForSchema(rawArgsObj, featureSchema);
            // If an existing featureId is provided, update that feature instead of creating a new one.
            // Do not treat generic "id" input fields as feature IDs (e.g. Extrude id label).
            const targetId = argsObj?.featureId || argsObj?.featureID;
            const inputArgs = { ...(argsObj || {}) };
            if (Object.prototype.hasOwnProperty.call(inputArgs, 'featureId')) delete inputArgs.featureId;
            if (Object.prototype.hasOwnProperty.call(inputArgs, 'featureID')) delete inputArgs.featureID;
            let featureToAdd;
            if (targetId) {
                const existing = partHistory.features.find(f => f?.inputParams?.featureID === targetId);
                if (!existing) {
                    throw new Error(`Feature with ID '${targetId}' not found to modify.`);
                }
                // Ensure type compatibility
                if (existing.type !== featureName) {
                    throw new Error(`Feature type mismatch for '${targetId}'. Expected '${existing.type}', got '${featureName}'.`);
                }
                featureToAdd = existing;
            } else {
                featureToAdd = await partHistory.newFeature(featureName);
            }
            // Apply inputs
            await Object.assign(featureToAdd.inputParams, inputArgs);

            await partHistory.runHistory();
            this.addMessage('assistant', `Executed tool: ${featureName} with arguments: ${JSON.stringify(inputArgs, null, 2)}`);
            try { await this.dumpScreenshot({ sender: 'user', altText: `After executing ${featureName}` }); } catch (_) { }
            this.debugLog('callTool.done', { id: toolCall?.id || null, name: featureName, resultPreview: this.previewText(JSON.stringify(inputArgs)) });
            return JSON.stringify({ ok: true, executed: featureName, args: inputArgs });
        } catch (error) {
            console.error("Error calling tool:", error);
            this.debugLog('callTool.error', {
                id: toolCall?.id || null,
                name: toolCall?.function?.name || null,
                error: error?.message || String(error),
            });
            this.addMessage('assistant', `Sorry, there was an error executing the tool: ${error.message}`);
            // Provide structured error details back to the LLM for recovery
            try {
                const toolName = toolCall?.function?.name || 'unknown_tool';
                const toolArgs = toolCall?.function?.arguments || '';
                return JSON.stringify({ ok: false, tool: toolName, args: toolArgs, error: error?.message || String(error) });
            } catch (_) {
                return JSON.stringify({ ok: false, error: error?.message || String(error) });
            }
        }


    }


    setupTools() {
        // Auto-generate OpenAI tool specs from feature schemas
        const registry = this?.app?.viewer?.partHistory?.featureRegistry;
        if (!registry || !Array.isArray(registry.features)) {
            console.warn('Feature registry not available; no tools generated');
            return [];
        }

        // Sanitize tool function names: use feature short names, normalized for API
        const toToolName = (raw) => {
            let name = String(raw || '').trim();
            if (!name) name = 'feature';
            // Replace non-alphanumeric (allow A-Z too) with underscore; collapse repeats
            name = name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_{2,}/g, '_');
            // Ensure starts with a letter
            if (!/^[A-Za-z]/.test(name)) name = `F_${name}`;
            if (name.length > 64) name = name.slice(0, 64).replace(/_+$/, '');
            if (!name) name = 'feature';
            return name;
        };

        // Map BREP schema types → JSON Schema (for Chat Completions tools)
        const mapParamSchema = (key, def) => {
            const hint = def?.hint || def?.label || '';
            const t = String(def?.type || 'string');
            const addDefault = (obj, val) => {
                if (val === undefined) return obj;
                try { obj.default = val; } catch { }
                return obj;
            };
            if (t === 'number') {
                // Keep numeric fields permissive because some models emit numbers as strings.
                // Runtime sanitization in PartHistory will coerce expressions/strings to numbers.
                const parts = [];
                if (hint) parts.push(hint);
                parts.push('Numeric value; accepts number or numeric string.');
                if (Number.isFinite(def?.min)) parts.push(`Minimum: ${def.min}.`);
                if (Number.isFinite(def?.max)) parts.push(`Maximum: ${def.max}.`);
                const out = { description: parts.join(' ') };
                return addDefault(out, def?.default_value);
            }
            if (t === 'boolean') {
                return addDefault({ type: 'boolean', description: hint }, def?.default_value);
            }
            if (t === 'string' || t === 'textarea' || t === 'file' || t === 'line' || t === 'circle' || t === 'arc' || t === 'bezier' || t === 'constraint' || t === 'vertex' || t === 'edge' || t === 'point') {
                return addDefault({ type: 'string', description: hint }, (def?.default_value == null ? undefined : def.default_value));
            }
            if (t === 'options') {
                const opts = Array.isArray(def?.options) ? def.options.filter(v => v != null).map(v => String(v)) : undefined;
                const out = { type: 'string', description: hint };
                if (opts && opts.length) out.enum = opts;
                return addDefault(out, def?.default_value);
            }
            if (t === 'vec3') {
                const out = { description: hint || 'Vector3 as [x, y, z] numbers (or numeric strings)', type: 'array', items: { description: 'Number or numeric string' }, minItems: 3, maxItems: 3 };
                return addDefault(out, def?.default_value);
            }
            if (t === 'transform') {
                const out = {
                    description: hint || 'Transform with position, rotationEuler, scale',
                    type: 'object',
                    properties: {
                        position: { type: 'array', items: { description: 'Number or numeric string' }, minItems: 3, maxItems: 3, description: 'Position [x,y,z]' },
                        rotationEuler: { type: 'array', items: { description: 'Number or numeric string' }, minItems: 3, maxItems: 3, description: 'Rotation Euler degrees [x,y,z]' },
                        scale: { type: 'array', items: { description: 'Number or numeric string' }, minItems: 3, maxItems: 3, description: 'Scale [x,y,z]' },
                    },
                    required: [],
                };
                return addDefault(out, def?.default_value);
            }
            if (t === 'reference_selection') {
                const multi = def?.multiple !== false;
                const desc = hint || 'Reference by object names';
                if (multi) return { type: 'array', description: desc, items: { type: 'string' } };
                return { type: 'string', description: desc };
            }
            if (t === 'component_selector') {
                return { type: 'string', description: hint || 'Component name to insert' };
            }
            if (t === 'boolean_operation') {
                const out = {
                    description: hint || 'Boolean operation parameters',
                    type: 'object',
                    properties: {
                        operation: { type: 'string', description: 'Boolean op', enum: ['NONE', 'UNION', 'SUBTRACT', 'INTERSECT'] },
                        targets: { type: 'array', description: 'Names of target solids', items: { type: 'string' } },
                        biasDistance: { description: 'Small bias to reduce coplanar artifacts (number or numeric string)' },
                        offsetCoplanarCap: { type: 'string', description: 'Optional cap handling flag' },
                        offsetDistance: { description: 'Optional offset distance for caps (number or numeric string)' },
                    },
                    required: [],
                };
                return addDefault(out, def?.default_value);
            }
            return addDefault({ type: 'string', description: hint }, (def?.default_value == null ? undefined : def.default_value));
        };

        const usedNames = new Set();
        const tools = [];
        for (const FeatureClass of registry.features) {
            if (!FeatureClass || typeof FeatureClass !== 'function') continue;
            const schema = FeatureClass?.inputParamsSchema;
            if (!schema || typeof schema !== 'object') continue;

            // Function name: use short feature code (e.g., P.CU), sanitized
            const shortRaw = FeatureClass?.shortName || FeatureClass?.featureShortName || FeatureClass?.name || FeatureClass?.featureName || 'feature';
            let toolName = toToolName(shortRaw);
            if (usedNames.has(toolName)) {
                let i = 2;
                while (usedNames.has(`${toolName}_${i}`)) i++;
                toolName = `${toolName}_${i}`;
            }
            usedNames.add(toolName);

            // Description: long, human readable feature name
            const description = FeatureClass?.featureName || String(shortRaw);

            // Build parameters JSON schema
            const properties = {};
            const required = [];
            for (const key of Object.keys(schema)) {
                const def = schema[key] || {};
                properties[key] = mapParamSchema(key, def);
                const hasDefault = Object.prototype.hasOwnProperty.call(def, 'default_value');
                if (!hasDefault) {
                    if (!['reference_selection', 'boolean_operation', 'transform', 'component_selector'].includes(String(def?.type))) {
                        required.push(key);
                    }
                }
            }

            // Allow LLM to target an existing feature by ID for modification
            properties.featureId = { type: 'string', description: 'Existing feature ID to modify instead of creating a new one' };
            const parameters = { type: 'object', properties };
            if (required.length) parameters.required = required;

            tools.push({ type: 'function', function: { name: toolName, description, parameters } });
        }
        console.log('Generated tool specs from feature schemas:', tools);





        // add special tools for screenshots and part history dumping
        tools.push({
            type: 'function',
            function: {
                name: 'upsert_sketch',
                description: 'Create or update a Sketch feature from raw sketch JSON so the model can use any supported sketch geometry and constraints.',
                parameters: {
                    type: 'object',
                    properties: {
                        featureId: { type: 'string', description: 'Optional existing Sketch feature ID to update. Omit to create a new Sketch feature.' },
                        sketchPlane: { type: 'string', description: 'Optional plane/face reference name for SketchFeature.sketchPlane.' },
                        curveResolution: { description: 'Optional curve resolution used when discretizing arcs/circles/beziers.' },
                        allowGround: { type: 'boolean', description: 'Optional. Keep ⏚ fixed/ground constraints when true. Default false.' },
                        preferCenterConstraints: { type: 'boolean', description: 'Optional. Add non-fixed center-point relations when possible. Default true.' },
                        centerTolerance: { description: 'Optional numeric tolerance for detecting center-aligned points. Default 1e-6.' },
                        sketch: {
                            type: 'object',
                            description: 'Sketch object. You may also provide points/geometries/constraints at the top level.',
                            properties: {
                                points: {
                                    type: 'array',
                                    description: 'Points in sketch plane coordinates.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id: { description: 'Point ID (integer-like).' },
                                            x: { description: 'X coordinate (number or numeric string).' },
                                            y: { description: 'Y coordinate (number or numeric string).' },
                                            fixed: { type: 'boolean', description: 'Optional fixed point flag.' },
                                        },
                                        required: ['id', 'x', 'y'],
                                    },
                                },
                                geometries: {
                                    type: 'array',
                                    description: 'Sketch curves referencing point IDs.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id: { description: 'Geometry ID (integer-like).' },
                                            type: { type: 'string', enum: ['line', 'circle', 'arc', 'bezier'], description: 'Geometry kind.' },
                                            points: { type: 'array', items: { description: 'Point ID (integer-like).' }, description: 'line:[a,b], circle:[center,r], arc:[center,start,end], bezier:[a0,h0,h1,a1,...]' },
                                            construction: { type: 'boolean', description: 'Optional construction geometry flag.' },
                                        },
                                        required: ['type', 'points'],
                                    },
                                },
                                constraints: {
                                    type: 'array',
                                    description: 'Sketch constraints referencing point IDs.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id: { description: 'Constraint ID (integer-like).' },
                                            type: {
                                                type: 'string',
                                                enum: ['━', '│', '⟺', '⇌', '∥', '⟂', '∠', '≡', '⏛', '⋯', '⋱', '⏚', 'horizontal', 'vertical', 'distance', 'equal_distance', 'equal_radius', 'parallel', 'perpendicular', 'tangent', 'angle', 'coincident', 'point_on_line', 'midpoint', 'fixed', 'ground'],
                                                description: 'Constraint symbol or alias.',
                                            },
                                            points: { type: 'array', items: { description: 'Point ID (integer-like).' } },
                                            value: { description: 'Numeric value for dimensional constraints (distance, angle).' },
                                            displayStyle: { type: 'string', description: 'Optional display style (for example radius or diameter).' },
                                            labelX: { description: 'Optional label X location.' },
                                            labelY: { description: 'Optional label Y location.' },
                                        },
                                        required: ['type', 'points'],
                                    },
                                },
                            },
                            required: [],
                        },
                        points: { type: 'array', description: 'Top-level shortcut for sketch.points.', items: { type: 'object' } },
                        geometries: { type: 'array', description: 'Top-level shortcut for sketch.geometries.', items: { type: 'object' } },
                        constraints: { type: 'array', description: 'Top-level shortcut for sketch.constraints.', items: { type: 'object' } },
                    },
                    required: [],
                },
            },
        });

        tools.push({
            type: 'function',
            function: {
                name: 'dump_screenshot',
                description: 'Capture the current viewport as a screenshot and attach it to the conversation.',
                parameters: {
                    type: 'object',
                    properties: {
                        altText: { type: 'string', description: 'Alternative text for the screenshot' },
                    },
                    required: [],
                },
            },
        });

        tools.push({
            type: 'function',
            function: {
                name: 'dump_part_history',
                description: 'Dump the current part history as JSON and attach it to the conversation.',
                parameters: {
                    type: 'object',
                    properties: {},
                    required: [],
                },
            },
        });


        // add too to delete a particular feature. PartHistory.removeFeature(featureID)
        tools.push({
            type: 'function',
            function: {
                name: 'delete_feature',
                description: 'Delete a feature from the part history by its ID.',
                parameters: {
                    type: 'object',
                    properties: {
                        featureId: { type: 'string', description: 'The ID of the feature to delete' },
                    },
                    required: ['featureId'],
                },
            },
        });

        // add tools to modify/update an existing feature's parameters
        tools.push({
            type: 'function',
            function: {
                name: 'update_feature',
                description: 'Modify an existing feature by ID; only provided params are changed.',
                parameters: {
                    type: 'object',
                    properties: {
                        featureId: { type: 'string', description: 'ID of the feature to modify' },
                        params: { type: 'object', description: 'Partial input params to update on the feature' },
                    },
                    required: ['featureId', 'params'],
                },
            },
        });

        tools.push({
            type: 'function',
            function: {
                name: 'modify_feature',
                description: 'Alias of update_feature; modify an existing feature by ID with partial params.',
                parameters: {
                    type: 'object',
                    properties: {
                        featureId: { type: 'string', description: 'ID of the feature to modify' },
                        params: { type: 'object', description: 'Partial input params to update on the feature' },
                    },
                    required: ['featureId', 'params'],
                },
            },
        });




        return tools;
    }


}
