// add some basic styles
export const style = document.createElement('style');
style.textContent = `
            .message-list {
                max-height: 400px;
                overflow-y: auto;
                margin-bottom: 10px;
                padding: 10px;
                border: 1px solid #444;
                border-radius: 5px;
                background-color: #1e1e1e;
                color: #e0e0e0;
            }
            .message {
                margin-bottom: 10px;
                padding: 10px;
                border-radius: 5px;
                color: #e0e0e0;
                position: relative;
                white-space: pre-wrap;
                word-break: break-word;
            }
            .message img,
            .message-image {
                display: block;
                max-width: 100%;
                height: auto;
                border: 1px solid #555;
                border-radius: 4px;
            }
            .message-caption {
                font-size: 12px;
                opacity: 0.8;
                margin-top: 6px;
            }
            .message.user {
                background-color: #2d5a3d;
                align-self: flex-end;
            }
            .message.assistant {
                background-color: #5a2d2d;
                align-self: flex-start;
            }
            .chat-controls {
                display: flex;
                gap: 8px;
                margin-bottom: 8px;
            }
            .chat-controls button {
                padding: 6px 10px;
                border: 1px solid #555;
                background-color: #2a2a2a;
                color: #e0e0e0;
                border-radius: 4px;
                cursor: pointer;
            }
            .chat-controls button:hover { background-color: #333; }
            .delete-btn {
                position: absolute;
                top: 6px;
                right: 6px;
                border: none;
                background: transparent;
                color: #bbb;
                font-size: 14px;
                line-height: 1;
                cursor: pointer;
                padding: 2px 6px;
            }
            .delete-btn:hover { color: #fff; }
            /* Tool-call messages: horizontally scrollable JSON */
            .message.toolCall {
                overflow-x: auto;
            }
            .message.toolCall .toolcall-title {
                font-weight: bold;
                margin-bottom: 6px;
            }
            .message.toolCall pre.toolcall-json {
                margin: 0;
                white-space: pre; /* keep JSON unwrapped */
                min-width: max-content; /* trigger horizontal scrollbar when needed */
                font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
                font-size: 12px;
                line-height: 1.4;
            }
            .input-form {
                display: flex;
            }
            .input-form input {
                flex-grow: 1;
                padding: 10px;
                border: 1px solid #555;
                border-radius: 5px 0 0 5px;
                outline: none;
                background-color: #2a2a2a;
                color: #e0e0e0;
            }
            .input-form input:focus {
                border-color: #007bff;
                background-color: #333;
            }
            .input-form button {
                padding: 10px 20px;
                border: none;
                background-color: #007bff;
                color: white;
                border-radius: 0 5px 5px 0;
                cursor: pointer;
            }
            .input-form button:hover {
                background-color: #0056b3;
            }
        `;
