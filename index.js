/**
 * OpenRouter TTS Extension for SillyTavern
 *
 * Connects to OpenRouter's audio-capable models (gpt-4o-mini-tts, tts-1, tts-1-hd)
 * to provide text-to-speech for chat messages.
 */

import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const extensionName = "sillytavern-openrouter-tts";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";

// Models that support the /audio/speech endpoint pattern
const SPEECH_ENDPOINT_MODELS = ["openai/tts-1", "openai/tts-1-hd"];
// Models that use the chat completions endpoint with audio modalities
const CHAT_AUDIO_MODELS = ["openai/gpt-4o-mini-tts"];

const defaultSettings = {
    enabled: false,
    autoSpeak: true,
    narrateUser: false,
    apiKey: "",
    model: "openai/tts-1",
    voice: "coral",
    format: "mp3",
    speed: 1.0,
};

// ─── State ────────────────────────────────────────────────────
let audioQueue = [];
let isPlaying = false;
let currentAudio = null;
let lastProcessedMessageId = null;

// ─── Helpers ──────────────────────────────────────────────────

function getSettings() {
    return extension_settings[extensionName];
}

function getMimeType(format) {
    const map = {
        mp3: "audio/mpeg",
        wav: "audio/wav",
        opus: "audio/opus",
        aac: "audio/aac",
        flac: "audio/flac",
        pcm16: "audio/pcm",
    };
    return map[format] || "audio/mpeg";
}

/**
 * Strips common markup from text before sending to TTS.
 * Removes HTML, markdown emphasis, action asterisks, etc.
 */
function cleanTextForTTS(text) {
    if (!text) return "";
    return text
        // Strip HTML tags
        .replace(/<[^>]+>/g, "")
        // Remove markdown images
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        // Remove markdown links but keep text
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        // Remove bold/italic markers
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
        .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
        // Remove code blocks
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`([^`]+)`/g, "$1")
        // Remove blockquotes
        .replace(/^>\s?/gm, "")
        // Collapse whitespace
        .replace(/\s+/g, " ")
        .trim();
}

function setStatus(state, text) {
    const el = document.getElementById("openrouter_tts_status");
    if (!el) return;
    el.className = `openrouter-tts-status ${state}`;
    const textEl = el.querySelector(".status-text");
    if (textEl) textEl.textContent = text;
}

// ─── OpenRouter API ───────────────────────────────────────────

/**
 * Generate TTS audio via the OpenAI-compatible /audio/speech endpoint.
 * Works for tts-1 and tts-1-hd models.
 */
async function generateSpeechEndpoint(text) {
    const settings = getSettings();
    const response = await fetch(`${OPENROUTER_API_URL}/audio/speech`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${settings.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": window.location.href,
            "X-Title": "SillyTavern OpenRouter TTS",
        },
        body: JSON.stringify({
            model: settings.model,
            input: text,
            voice: settings.voice,
            response_format: settings.format,
            speed: settings.speed,
        }),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
            errorData?.error?.message || `API error: ${response.status} ${response.statusText}`
        );
    }

    // The response body is raw audio bytes
    return await response.blob();
}

/**
 * Generate TTS audio via chat completions with audio modalities.
 * Works for gpt-4o-mini-tts and similar models.
 */
async function generateChatAudio(text) {
    const settings = getSettings();
    const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${settings.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": window.location.href,
            "X-Title": "SillyTavern OpenRouter TTS",
        },
        body: JSON.stringify({
            model: settings.model,
            modalities: ["text", "audio"],
            audio: {
                voice: settings.voice,
                format: settings.format,
            },
            messages: [
                {
                    role: "user",
                    content: `Please read the following text aloud exactly as written, without adding anything:\n\n${text}`,
                },
            ],
        }),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
            errorData?.error?.message || `API error: ${response.status} ${response.statusText}`
        );
    }

    const data = await response.json();

    // Audio comes back as base64 in message.audio.data
    const audioData = data?.choices?.[0]?.message?.audio?.data;
    if (!audioData) {
        throw new Error("No audio data in response. The model may not support audio output.");
    }

    // Decode base64 to blob
    const binaryString = atob(audioData);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return new Blob([bytes], { type: getMimeType(settings.format) });
}

/**
 * Main TTS generation function - picks the right approach based on model.
 */
async function generateTTS(text) {
    const settings = getSettings();

    if (!settings.apiKey) {
        throw new Error("OpenRouter API key is not set.");
    }

    const cleanedText = cleanTextForTTS(text);
    if (!cleanedText) {
        throw new Error("No text to speak after cleaning.");
    }

    // Truncate very long text to avoid excessive API costs
    const maxChars = 4096;
    const truncatedText =
        cleanedText.length > maxChars
            ? cleanedText.substring(0, maxChars) + "..."
            : cleanedText;

    if (CHAT_AUDIO_MODELS.includes(settings.model)) {
        return await generateChatAudio(truncatedText);
    } else {
        return await generateSpeechEndpoint(truncatedText);
    }
}

// ─── Audio Playback ───────────────────────────────────────────

async function playAudioBlob(blob) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentAudio = audio;

        audio.onended = () => {
            URL.revokeObjectURL(url);
            currentAudio = null;
            resolve();
        };

        audio.onerror = (e) => {
            URL.revokeObjectURL(url);
            currentAudio = null;
            reject(new Error("Audio playback failed."));
        };

        audio.play().catch((err) => {
            URL.revokeObjectURL(url);
            currentAudio = null;
            reject(err);
        });
    });
}

function stopPlayback() {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
    }
    audioQueue = [];
    isPlaying = false;

    // Remove all playing indicators
    document.querySelectorAll(".openrouter-tts-speak-btn.playing").forEach((btn) => {
        btn.classList.remove("playing");
    });
}

async function processQueue() {
    if (isPlaying || audioQueue.length === 0) return;
    isPlaying = true;

    while (audioQueue.length > 0) {
        const item = audioQueue.shift();
        try {
            setStatus("checking", "Generating...");
            const blob = await generateTTS(item.text);
            setStatus("connected", "Playing...");
            await playAudioBlob(blob);
        } catch (err) {
            console.error("[OpenRouter TTS] Playback error:", err);
            toastr.error(err.message, "OpenRouter TTS Error");
            setStatus("disconnected", `Error: ${err.message}`);
        }
    }

    isPlaying = false;
    setStatus("connected", "Connected");
}

function enqueueText(text) {
    audioQueue.push({ text });
    processQueue();
}

// ─── SillyTavern Event Hooks ─────────────────────────────────

function onMessageReceived(messageIndex) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoSpeak) return;

    const context = getContext();
    const chat = context.chat;
    if (!chat || messageIndex < 0 || messageIndex >= chat.length) return;

    const message = chat[messageIndex];

    // Skip if already processed
    const messageId = `${messageIndex}_${message.mes?.length || 0}`;
    if (messageId === lastProcessedMessageId) return;
    lastProcessedMessageId = messageId;

    // Skip user messages unless narrate user is on
    if (message.is_user && !settings.narrateUser) return;

    // Skip system messages
    if (message.is_system) return;

    const text = message.mes;
    if (text) {
        enqueueText(text);
    }
}

function addSpeakButtonsToMessages() {
    // Add speak buttons to message action bars
    document.querySelectorAll(".mes").forEach((mesEl) => {
        if (mesEl.querySelector(".openrouter-tts-speak-btn")) return;

        const extraButtons = mesEl.querySelector(".extraMesButtons, .mes_buttons");
        if (!extraButtons) return;

        const btn = document.createElement("div");
        btn.className = "openrouter-tts-speak-btn mes_button fa-solid fa-volume-up";
        btn.title = "Speak with OpenRouter TTS";
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const settings = getSettings();
            if (!settings.enabled) {
                toastr.warning("OpenRouter TTS is disabled. Enable it in settings.", "OpenRouter TTS");
                return;
            }

            const mesText = mesEl.querySelector(".mes_text");
            if (mesText) {
                enqueueText(mesText.textContent || mesText.innerText);
            }
        });

        extraButtons.prepend(btn);
    });
}

// ─── Settings UI Logic ───────────────────────────────────────

async function testTTS() {
    const settings = getSettings();

    if (!settings.apiKey) {
        toastr.warning("Please enter your OpenRouter API key first.", "OpenRouter TTS");
        return;
    }

    try {
        setStatus("checking", "Testing...");
        const blob = await generateTTS(
            "Hello! This is a test of the OpenRouter text to speech system. If you can hear this, everything is working correctly."
        );
        setStatus("connected", "Connected");
        toastr.success("TTS is working!", "OpenRouter TTS");
        await playAudioBlob(blob);
    } catch (err) {
        setStatus("disconnected", `Error: ${err.message}`);
        toastr.error(err.message, "OpenRouter TTS Test Failed");
    }
}

async function verifyApiKey() {
    const settings = getSettings();
    if (!settings.apiKey) {
        setStatus("disconnected", "No API key");
        return;
    }

    try {
        setStatus("checking", "Verifying...");

        const response = await fetch(`${OPENROUTER_API_URL}/auth/key`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${settings.apiKey}`,
            },
        });

        if (response.ok) {
            setStatus("connected", "Connected");
        } else {
            setStatus("disconnected", "Invalid API key");
        }
    } catch (err) {
        setStatus("disconnected", "Connection failed");
    }
}

function loadSettingsUI() {
    const settings = getSettings();

    $("#openrouter_tts_enabled").prop("checked", settings.enabled);
    $("#openrouter_tts_auto_speak").prop("checked", settings.autoSpeak);
    $("#openrouter_tts_narrate_user").prop("checked", settings.narrateUser);
    $("#openrouter_tts_api_key").val(settings.apiKey);
    $("#openrouter_tts_model").val(settings.model);
    $("#openrouter_tts_voice").val(settings.voice);
    $("#openrouter_tts_format").val(settings.format);
    $("#openrouter_tts_speed").val(settings.speed);
    $("#openrouter_tts_speed_value").text(parseFloat(settings.speed).toFixed(2));
}

function bindSettingsEvents() {
    // Enable toggle
    $("#openrouter_tts_enabled").on("change", function () {
        getSettings().enabled = $(this).prop("checked");
        saveSettingsDebounced();
    });

    // Auto-speak toggle
    $("#openrouter_tts_auto_speak").on("change", function () {
        getSettings().autoSpeak = $(this).prop("checked");
        saveSettingsDebounced();
    });

    // Narrate user toggle
    $("#openrouter_tts_narrate_user").on("change", function () {
        getSettings().narrateUser = $(this).prop("checked");
        saveSettingsDebounced();
    });

    // API Key
    $("#openrouter_tts_api_key").on("input", function () {
        getSettings().apiKey = $(this).val().trim();
        saveSettingsDebounced();
    });

    // API Key - verify on blur
    $("#openrouter_tts_api_key").on("blur", function () {
        verifyApiKey();
    });

    // Toggle key visibility
    $("#openrouter_tts_toggle_key").on("click", function () {
        const input = document.getElementById("openrouter_tts_api_key");
        const icon = this.querySelector("i");
        if (input.type === "password") {
            input.type = "text";
            icon.className = "fa-solid fa-eye-slash";
        } else {
            input.type = "password";
            icon.className = "fa-solid fa-eye";
        }
    });

    // Model
    $("#openrouter_tts_model").on("change", function () {
        getSettings().model = $(this).val();
        saveSettingsDebounced();
    });

    // Voice
    $("#openrouter_tts_voice").on("change", function () {
        getSettings().voice = $(this).val();
        saveSettingsDebounced();
    });

    // Format
    $("#openrouter_tts_format").on("change", function () {
        getSettings().format = $(this).val();
        saveSettingsDebounced();
    });

    // Speed
    $("#openrouter_tts_speed").on("input", function () {
        const val = parseFloat($(this).val());
        getSettings().speed = val;
        $("#openrouter_tts_speed_value").text(val.toFixed(2));
        saveSettingsDebounced();
    });

    // Test button
    $("#openrouter_tts_test").on("click", testTTS);

    // Stop button
    $("#openrouter_tts_stop").on("click", stopPlayback);
}

// ─── Initialization ──────────────────────────────────────────

jQuery(async () => {
    // Initialize settings
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }

    // Fill in any missing default keys (for upgrades)
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = value;
        }
    }

    // Load and inject settings HTML
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
    } catch (err) {
        console.error("[OpenRouter TTS] Failed to load settings HTML:", err);
        return;
    }

    // Set up UI
    loadSettingsUI();
    bindSettingsEvents();

    // Verify API key on load
    verifyApiKey();

    // Listen for new messages
    if (eventSource) {
        eventSource.on(event_types.MESSAGE_RECEIVED, (messageIndex) => {
            onMessageReceived(messageIndex);
        });

        eventSource.on(event_types.MESSAGE_SENT, (messageIndex) => {
            onMessageReceived(messageIndex);
        });
    }

    // Observe chat for new messages to add speak buttons
    const chatObserver = new MutationObserver(() => {
        addSpeakButtonsToMessages();
    });

    const chatContainer = document.getElementById("chat");
    if (chatContainer) {
        chatObserver.observe(chatContainer, { childList: true, subtree: true });
    }

    // Initial button injection
    addSpeakButtonsToMessages();

    console.log("[OpenRouter TTS] Extension loaded.");
});
