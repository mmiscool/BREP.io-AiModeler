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
        this.apiKey = ''
        this.apiKey = prompt("Please enter your OpenAI API key:", this.apiKey);

        this.openAiClient = new openai({
            apiKey: this.apiKey,
            baseURL: "https://api.groq.com/openai/v1",
            dangerouslyAllowBrowser: true,
        });


        this.container = container;
        this.messages = [];
        this.nextMsgId = 1;
        this.modelId = "meta-llama/llama-4-scout-17b-16e-instruct";
        this.toolSpecs = this.setupTools();
        this.initUI();
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
        // Keep conversation state concise
        this.messages.push({ id, sender: 'assistant', text: `Tool Call: ${toolCall.function?.name}` });
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
        this.messages.push(toolMsg);
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
                // Groq expects only { image_url: { url } }
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
            'vision', 'gpt-4o', 'gpt-4.1', 'omni', 'o3', 'o4', 'vl',
            // Groq Llama 4 multimodal models
            'llama-4-scout', 'llama 4 scout', 'scout', 'maverick', 'llama-4'
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
    }

    async sendMessage(message) {
        try {
            const model = this.modelId;
            const payloadMessages = [
                { role: "system", content: prompts.system },
                // insert the current feature history in to the conversation.
                { role: "user", content: `Here is the part history. This is always the latest and greatest: ${await this?.app?.viewer?.partHistory?.toJSON()}` },
                ...this.buildChatMessages(model)
            ];
            console.log("Built chat messages for API:", payloadMessages);
            console.log("Available tools for this model:", this.toolSpecs);

            const response = await this.openAiClient.chat.completions.create({
                model,
                tools: this.toolSpecs,
                tool_choice: "auto",
                parallel_tool_calls: false,
                messages: payloadMessages,
            });

            const responseMessage = response.choices[0].message;
            this.addMessage('assistant', responseMessage.content);

            this.processResponse(responseMessage);

        } catch (error) {
            console.error("Error sending message to OpenAI:", error);
            this.addMessage('assistant', "Sorry, there was an error processing your request.");
        }
    }


    async processResponse(responseMessage) {
        const model = this.modelId;
        const toolCalls = responseMessage.tool_calls ?? [];
        console.log("Tool calls from the message:", toolCalls);

        if (!toolCalls.length) return;

        // Execute tools, collect structured results
        const toolResults = [];
        for (const toolCall of toolCalls) {
            try {
                console.log("Processing tool call:", toolCall);
                this.addToolCallMessage(toolCall);
                const resultText = await this.callTool(toolCall);
                const msg = this.addToolResultMessage(toolCall, resultText ?? 'OK');
                toolResults.push(msg);
            } catch (error) {
                console.error("Error processing tool call:", error);
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
                { role: 'system', content: prompts.system },
                { role: 'user', content: `Here is the part history. This is always the latest and greatest: ${await this?.app?.viewer?.partHistory?.toJSON()}` },
                ...historyWithoutNewToolMsgs,
                { role: 'assistant', content: responseMessage.content || undefined, tool_calls: responseMessage.tool_calls },
                // Re-append the tool results in the correct order
                ...toolResults.map(m => ({ role: 'tool', tool_call_id: m.tool_call_id, content: m.text || '' })),
            ];

            console.log('Follow-up payload after tools:', payloadMessages);

            const followup = await this.openAiClient.chat.completions.create({
                model,
                tools: this.toolSpecs,
                tool_choice: "auto",
                parallel_tool_calls: false,
                messages: payloadMessages,
            });

            const msg = followup.choices?.[0]?.message || {};
            this.addMessage('assistant', msg.content || '');
            // Process any further tool calls recursively
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
                await this.processResponse(msg);
            }
        } catch (e) {
            console.error('Follow-up after tools failed:', e);
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
            // Merge new params into existing inputParams
            Object.assign(feat.inputParams, params);
            if (typeof ph.runHistory === 'function') {
                await ph.runHistory();
            }
            this.addMessage('assistant', `Modified feature ${featureId} with params: ${JSON.stringify(params, null, 2)}`);
            try { await this.dumpScreenshot({ sender: 'user', altText: `After modifying ${featureId}` }); } catch (_) { }
            return { ok: true, featureId, params };
        } catch (e) {
            console.error('modifyFeature failed:', e);
            this.addMessage('assistant', `Failed to modify feature: ${e?.message || e}`);
            return { ok: false, error: e?.message || String(e) };
        }
    }





    async callTool(toolCall) {
        try {

            // add code here to handle the special case tools like 'dump_screenshot', 'dump_part_history', and 'delete_feature' before processing regular feature calls.
            if (toolCall.function.name === 'dump_screenshot') {
                // Pass through optional altText
                let args = {};
                try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch { args = {}; }
                await this.dumpScreenshot({ sender: 'user', altText: args?.altText || 'CAD Screenshot' });
                return JSON.stringify({ ok: true, screenshot: true, altText: args?.altText || 'CAD Screenshot' });
            } else if (toolCall.function.name === 'dump_part_history') {
                const phJson = await this.dumpPartHistory();
                return typeof phJson === 'string' ? phJson : JSON.stringify(phJson ?? {});
            } else if (toolCall.function.name === 'delete_feature') {
                const ok = await this.deleteFeature(toolCall.function.arguments);
                let parsed = {};
                try { parsed = JSON.parse(toolCall.function.arguments || '{}'); } catch { }
                const featureId = parsed?.featureId || parsed?.featureID || parsed?.id;
                return JSON.stringify({ ok: !!ok, deleted: featureId });
            } else if (toolCall.function.name === 'update_feature' || toolCall.function.name === 'modify_feature') {
                const result = await this.modifyFeature(toolCall.function.arguments);
                return JSON.stringify(result);
            }









            const partHistory = this.app.viewer.partHistory; // Assuming this is how you access the part history


            console.log("Processing tool call:", toolCall);
            const { name, arguments: args } = toolCall.function;
            console.log(`Calling tool: ${name} with arguments:`, args);

            // fix the name to match the feature short name if necessary by replacing underscores with dots and ensuring it matches the feature registry naming convention
            const featureName = name.replace(/_/g, '.');
            console.log(`Resolved feature name: ${featureName}`);

            const argsObj = JSON.parse(args || '{}');
            // If an existing featureId is provided, update that feature instead of creating a new one
            const targetId = argsObj?.featureId || argsObj?.featureID || argsObj?.id;
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
            await Object.assign(featureToAdd.inputParams, argsObj);

            await partHistory.runHistory();
            this.addMessage('assistant', `Executed tool: ${featureName} with arguments: ${JSON.stringify(argsObj, null, 2)}`);
            try { await this.dumpScreenshot({ sender: 'user', altText: `After executing ${featureName}` }); } catch (_) { }
            return JSON.stringify({ ok: true, executed: featureName, args: argsObj });
        } catch (error) {
            console.error("Error calling tool:", error);
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
                const out = { type: 'number', description: hint };
                if (Number.isFinite(def?.min)) out.minimum = def.min;
                if (Number.isFinite(def?.max)) out.maximum = def.max;
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
                const out = { description: hint || 'Vector3 as [x, y, z] numbers', type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
                return addDefault(out, def?.default_value);
            }
            if (t === 'transform') {
                const out = {
                    description: hint || 'Transform with position, rotationEuler, scale',
                    type: 'object',
                    properties: {
                        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Position [x,y,z]' },
                        rotationEuler: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Rotation Euler degrees [x,y,z]' },
                        scale: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Scale [x,y,z]' },
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
                        biasDistance: { type: 'number', description: 'Small bias to reduce coplanar artifacts' },
                        offsetCoplanarCap: { type: 'string', description: 'Optional cap handling flag' },
                        offsetDistance: { type: 'number', description: 'Optional offset distance for caps' },
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
            const shortRaw = FeatureClass?.featureShortName || FeatureClass?.name || FeatureClass?.featureName || 'feature';
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
