import { useState, useEffect } from "react";
import { ChevronDown, ChevronUp, Copy, Check, Loader2, Zap, Key } from "lucide-react";
import { toast } from "sonner";
import { apiFetch, getUser } from "@/lib/auth";
import { Link } from "wouter";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const WORKING_MODELS = [
  // ── Qwen (via chat.qwen.ai — guest mode, tanpa login, curl_cffi WAF bypass) ──
  // Semua model berikut diuji ✅ berjalan tanpa QWEN_SESSION_TOKEN (Juni 2026)
  { id: "qwen3.7-plus",        label: "qwen3.7-plus ✦ (vision, search, thinking)",  group: "Qwen" },
  { id: "qwen3.7-max",         label: "qwen3.7-max (flagship, text-only)",           group: "Qwen" },
  { id: "qwen3.6-plus",        label: "qwen3.6-plus (vision, search, thinking)",     group: "Qwen" },
  { id: "qwen3.6-max-preview", label: "qwen3.6-max-preview",                         group: "Qwen" },
  { id: "qwen3.5-397b-a17b",   label: "qwen3.5-397b-a17b (397B params)",             group: "Qwen" },
  { id: "qwen3.5-122b-a10b",   label: "qwen3.5-122b-a10b (122B)",                    group: "Qwen" },
  { id: "qwen3.5-plus",        label: "qwen3.5-plus",                                group: "Qwen" },
  { id: "qwen3-coder-plus",    label: "qwen3-coder-plus (spesialis kode)",            group: "Qwen" },
  { id: "qwen3.6-35b-a3b",     label: "qwen3.6-35b-a3b (MoE 35B)",                  group: "Qwen" },
  { id: "qwen3.6-27b",         label: "qwen3.6-27b (27B dense)",                     group: "Qwen" },
  { id: "qwen3-235b-a22b",     label: "qwen3-235b-a22b (→ 235B-2507)",              group: "Qwen" },
  { id: "qwen3-30b-a3b",       label: "qwen3-30b-a3b (→ 35B MoE)",                  group: "Qwen" },
  { id: "qwen3.5-flash",       label: "qwen3.5-flash (tercepat/ringan)",             group: "Qwen" },
  { id: "minimax-m3",             label: "minimax-m3 (MiniMax M3 Thinking)",       group: "MiniMax" },
  { id: "minimax-m3-thinking",    label: "minimax-m3-thinking",                    group: "MiniMax" },
  { id: "minimax-m2.7",           label: "minimax-m2.7 (MiniMax M2.7)",            group: "MiniMax" },
  { id: "minimax-m2.7-highspeed", label: "minimax-m2.7-highspeed (M2.7 HighSpeed)", group: "MiniMax" },
  // ── Opera Aria (unlimited via anonymous session) ──
  { id: "aria",             label: "aria (Opera Aria)", group: "Opera" },
  // ── Yqcloud (GPT-4 proxy, userId pool) ──
  { id: "yqcloud",          label: "yqcloud (GPT-4)", group: "Yqcloud" },
  { id: "yqcloud-gpt4",     label: "yqcloud-gpt4", group: "Yqcloud" },
  // ── Cohere (command-a/r via HuggingFace, conv pool) ──
  { id: "command-a",        label: "command-a (latest)", group: "Cohere" },
  { id: "command-r-plus",   label: "command-r-plus", group: "Cohere" },
  { id: "command-r",        label: "command-r", group: "Cohere" },
  { id: "command-r7b",      label: "command-r7b", group: "Cohere" },
  // ── Perplexity (no auth, web search AI, IP rate limit ~15 req/day) ──
  { id: "perplexity",           label: "perplexity (turbo)", group: "Perplexity" },
  // ── GPTFree (Firebase anonymous auth, no account needed) ──
  { id: "gptfree",              label: "gptfree (default)", group: "GPTFree" },
  { id: "gptfree-pro",          label: "gptfree-pro", group: "GPTFree" },
  // ── AlgoChat (Gemini 3 Flash Preview via algochat.app guest session) ──
  { id: "algochat",             label: "algochat (Gemini 3 Flash Preview)", group: "AlgoChat" },
  { id: "gemini-3-flash-preview", label: "gemini-3-flash-preview", group: "AlgoChat" },
  // ── ChatAIBot (Claude/DeepSeek/GPT via chataibot.pro promo-chat, no auth) ──
  { id: "chataibot-claude-haiku",  label: "chataibot-claude-haiku (Claude Haiku 4.5)",  group: "ChatAIBot" },
  { id: "chataibot-claude-sonnet", label: "chataibot-claude-sonnet (Claude Sonnet 4.5)", group: "ChatAIBot" },
  { id: "chataibot-deepseek-r1",   label: "chataibot-deepseek-r1 (DeepSeek R1)",         group: "ChatAIBot" },
  { id: "chataibot-gpt4-nano",     label: "chataibot-gpt4-nano (GPT-4.1 nano)",          group: "ChatAIBot" },
  // ── Kimi (Moonshot AI Kimi-K2 via Connect RPC, requires KIMI_TOKEN) ──────
  { id: "kimi-k2",       label: "kimi-k2 (Moonshot Kimi K2)",           group: "Kimi" },
  { id: "kimi-search",   label: "kimi-search (Kimi + Web Search)",       group: "Kimi" },
  { id: "kimi-research", label: "kimi-research (Kimi Deep Research)",    group: "Kimi" },
  // ── DeepSeek (web scraping via chat.deepseek.com, requires DEEPSEEK_TOKEN) ─
  { id: "deepseek-chat",     label: "deepseek-chat (DeepSeek V3)",           group: "DeepSeek" },
  { id: "deepseek-reasoner", label: "deepseek-reasoner (DeepSeek R1)",       group: "DeepSeek" },
  { id: "deepseek-search",   label: "deepseek-search (DeepSeek V3 + Search)",group: "DeepSeek" },
];

const MODEL_GROUPS = [...new Set(WORKING_MODELS.map(m => m.group))];

function syntaxHighlight(json: unknown): string {
  const str = typeof json === "string" ? json : JSON.stringify(json, null, 2);
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        let cls = "num";
        if (/^"/.test(match)) cls = /:$/.test(match) ? "key" : "str";
        else if (/true|false/.test(match)) cls = "bool";
        else if (/null/.test(match)) cls = "null";
        return `<span class="${cls}">${match}</span>`;
      }
    );
}

function CodeBlock({ content, lang = "" }: { content: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative group">
      <pre className={`bg-gray-950 text-gray-100 rounded-lg p-4 text-xs font-mono overflow-x-auto leading-relaxed ${lang === "json" ? "" : ""}`}>{content}</pre>
      <button
        onClick={() => { navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="absolute top-2 right-2 p-1.5 rounded bg-white/10 hover:bg-white/20 text-white/70 hover:text-white transition-colors opacity-0 group-hover:opacity-100"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

interface ApiKeyInfo { id: string; name: string; prefix: string; suffix: string }

function maskKey(prefix: string, suffix: string) { return `${prefix}${"*".repeat(12)}${suffix}`; }

// ── Models block ─────────────────────────────────────────────────────────────

function ModelsBlock({ apiKey }: { apiKey: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<unknown>(null);
  const [statusCode, setStatusCode] = useState<number | null>(null);
  const [responseTime, setResponseTime] = useState<number | null>(null);

  const handleExecute = async () => {
    if (!apiKey) { toast.error("Enter your API key first"); return; }
    setLoading(true);
    setResponse(null);
    const start = Date.now();
    try {
      const res = await fetch(`${BASE}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      setStatusCode(res.status);
      setResponseTime(Date.now() - start);
      setResponse(await res.json());
    } catch {
      setStatusCode(0);
      setResponseTime(Date.now() - start);
      setResponse({ error: { message: "Connection error" } });
      toast.error("Connection error");
    } finally {
      setLoading(false);
    }
  };

  const statusCls = statusCode === null ? "" : statusCode >= 200 && statusCode < 300 ? "status-2xx" : "status-4xx";
  const curlStr = `curl -X GET '${typeof window !== "undefined" ? window.location.protocol + "//" + window.location.host : ""}${BASE}/v1/models' \\\n  -H 'Authorization: Bearer ${apiKey || "<YOUR_API_KEY>"}'`;

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors text-left"
        onClick={() => setOpen(p => !p)}
      >
        <span className="method-badge-get">GET</span>
        <span className="font-mono text-sm font-medium text-foreground flex-1">/v1/models</span>
        <span className="hidden sm:block text-xs text-muted-foreground">List available models</span>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-border">
          <div className="px-3 sm:px-5 py-4 space-y-4">
            <p className="text-sm text-muted-foreground">Returns the list of models available via this gateway. Requires a valid API key.</p>

            <div className="flex gap-3">
              <button
                onClick={handleExecute}
                disabled={loading}
                className="flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground text-sm font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-60 transition-colors"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                Execute
              </button>
              <button onClick={() => { setResponse(null); setStatusCode(null); setResponseTime(null); }} className="px-6 py-2.5 border border-border text-sm font-semibold rounded-lg hover:bg-muted transition-colors">Clear</button>
            </div>

            {(response !== null || loading) && (
              <div className="space-y-3 pt-2 border-t border-border">
                <h3 className="text-sm font-semibold text-foreground">Responses</h3>
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5 font-medium uppercase tracking-wider">Curl</div>
                  <CodeBlock content={curlStr} />
                </div>
                {loading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
                    <Loader2 className="w-4 h-4 animate-spin" /> Awaiting response...
                  </div>
                ) : (
                  <div className="border border-border rounded-lg overflow-hidden">
                    <div className="hidden sm:grid sm:grid-cols-[80px_1fr] bg-muted text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      <div className="px-4 py-2 border-r border-border">Code</div>
                      <div className="px-4 py-2">Details</div>
                    </div>
                    <div className="sm:grid sm:grid-cols-[80px_1fr] border-t border-border">
                      <div className="px-4 py-3 sm:border-r sm:border-border flex items-center gap-2 border-b border-border sm:border-b-0">
                        <span className={statusCls}>{statusCode ?? "—"}</span>
                      </div>
                      <div className="px-4 py-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground font-medium">
                            Response body {responseTime !== null && <span className="ml-2 text-foreground/70">{responseTime}ms</span>}
                          </span>
                          <button onClick={() => { navigator.clipboard.writeText(JSON.stringify(response, null, 2)); toast.success("Copied"); }} className="text-xs px-2 py-0.5 border border-border rounded hover:bg-muted transition-colors">Copy</button>
                        </div>
                        <div className="code-block overflow-x-auto" dangerouslySetInnerHTML={{ __html: syntaxHighlight(JSON.stringify(response, null, 2)) }} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Image Generations block ───────────────────────────────────────────────────

function ImageGenerationsBlock({ apiKey }: { apiKey: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState("A beautiful sunset over mountains, photorealistic");
  const [n, setN] = useState("1");
  const [response, setResponse] = useState<unknown>(null);
  const [statusCode, setStatusCode] = useState<number | null>(null);
  const [responseTime, setResponseTime] = useState<number | null>(null);

  const handleExecute = async () => {
    if (!apiKey) { toast.error("Enter your API key first"); return; }
    if (!prompt.trim()) { toast.error("Prompt is required"); return; }
    setLoading(true);
    setResponse(null);
    const start = Date.now();
    try {
      const res = await fetch(`${BASE}/v1/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ prompt: prompt.trim(), n: parseInt(n) || 1 }),
      });
      setStatusCode(res.status);
      setResponseTime(Date.now() - start);
      setResponse(await res.json());
    } catch {
      setStatusCode(0);
      setResponseTime(Date.now() - start);
      setResponse({ error: { message: "Connection error" } });
      toast.error("Connection error");
    } finally {
      setLoading(false);
    }
  };

  const host = typeof window !== "undefined" ? `${window.location.protocol}//${window.location.host}` : "";
  const curlStr = `curl -X POST '${host}${BASE}/v1/images/generations' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer ${apiKey || "<YOUR_API_KEY>"}' \\
  -d '{"prompt": "${prompt.trim()}", "n": ${parseInt(n) || 1}}'`;

  const statusCls = statusCode === null ? "" : statusCode >= 200 && statusCode < 300 ? "status-2xx" : "status-4xx";
  const imageUrls = response && typeof response === "object"
    ? ((response as { data?: Array<{ url?: string }> }).data ?? []).map(d => d.url).filter(Boolean) as string[]
    : [];

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors text-left"
        onClick={() => setOpen(p => !p)}
      >
        <span className="method-badge-post">POST</span>
        <span className="font-mono text-sm font-medium text-foreground flex-1">/v1/images/generations</span>
        <span className="hidden sm:block text-xs text-muted-foreground">Image Generation (Qwen Wan)</span>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-border">
          <div className="px-3 sm:px-5 py-4 space-y-4">
            <p className="text-sm text-muted-foreground">Generate images using Qwen's Wan model via OpenAI-compatible format. Response time ~30–50s.</p>

            <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
              {/* prompt */}
              <div className="flex flex-col sm:grid sm:grid-cols-[160px_1fr]">
                <div className="px-4 py-3 sm:border-r border-border border-b sm:border-b-0 bg-muted/30">
                  <div className="font-mono text-sm font-semibold">prompt</div>
                  <div className="text-[11px] text-muted-foreground font-semibold">* required</div>
                  <div className="text-[11px] text-muted-foreground">string</div>
                </div>
                <div className="px-4 py-3">
                  <textarea
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    rows={2}
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors resize-none"
                  />
                </div>
              </div>
              {/* n */}
              <div className="flex flex-col sm:grid sm:grid-cols-[160px_1fr] bg-muted/10">
                <div className="px-4 py-3 sm:border-r border-border border-b sm:border-b-0 bg-muted/20">
                  <div className="font-mono text-sm font-semibold">n</div>
                  <div className="text-[11px] text-muted-foreground">integer (1–4)</div>
                </div>
                <div className="px-4 py-3">
                  <input
                    type="number" min="1" max="4"
                    value={n}
                    onChange={e => setN(e.target.value)}
                    className="w-24 border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors"
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleExecute}
                disabled={loading}
                className="flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground text-sm font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-60 transition-colors"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                {loading ? "Generating (~30–50s)…" : "Execute"}
              </button>
              <button onClick={() => { setResponse(null); setStatusCode(null); setResponseTime(null); }} className="px-6 py-2.5 border border-border text-sm font-semibold rounded-lg hover:bg-muted transition-colors">Clear</button>
            </div>

            {(response !== null || loading) && (
              <div className="space-y-3 pt-2 border-t border-border">
                <h3 className="text-sm font-semibold text-foreground">Responses</h3>
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5 font-medium uppercase tracking-wider">Curl</div>
                  <CodeBlock content={curlStr} />
                </div>
                {loading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
                    <Loader2 className="w-4 h-4 animate-spin" /> Generating image, please wait…
                  </div>
                ) : (
                  <div className="border border-border rounded-lg overflow-hidden">
                    <div className="hidden sm:grid sm:grid-cols-[80px_1fr] bg-muted text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      <div className="px-4 py-2 border-r border-border">Code</div>
                      <div className="px-4 py-2">Details</div>
                    </div>
                    <div className="sm:grid sm:grid-cols-[80px_1fr] border-t border-border">
                      <div className="px-4 py-3 sm:border-r sm:border-border flex items-center gap-2 border-b border-border sm:border-b-0">
                        <span className={statusCls}>{statusCode ?? "—"}</span>
                      </div>
                      <div className="px-4 py-3 space-y-3">
                        {imageUrls.length > 0 && (
                          <div className="space-y-2">
                            <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Generated Images</div>
                            <div className="flex flex-wrap gap-3">
                              {imageUrls.map((url, i) => (
                                <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                                  <img src={url} alt={`Generated ${i + 1}`} className="w-48 h-48 object-cover rounded-lg border border-border hover:opacity-90 transition-opacity" />
                                </a>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground font-medium">
                            Full response {responseTime !== null && <span className="ml-2 text-foreground/70">{responseTime}ms</span>}
                          </span>
                          <button onClick={() => { navigator.clipboard.writeText(JSON.stringify(response, null, 2)); toast.success("Copied"); }} className="text-xs px-2 py-0.5 border border-border rounded hover:bg-muted transition-colors">Copy</button>
                        </div>
                        <div className="code-block overflow-x-auto" dangerouslySetInnerHTML={{ __html: syntaxHighlight(JSON.stringify(response, null, 2)) }} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main playground ──────────────────────────────────────────────────────────

export default function Playground() {
  const user = getUser();
  const [model, setModel] = useState("qwen3.7-plus");
  const [messages, setMessages] = useState(JSON.stringify([
    { role: "user", content: "Hello! What is 2 + 2?" }
  ], null, 2));
  const [systemPrompt, setSystemPrompt] = useState("");
  const [temperature, setTemperature] = useState("0.7");
  const [apiKey, setApiKey] = useState("");
  const [userKeys, setUserKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<unknown>(null);
  const [responseTime, setResponseTime] = useState<number | null>(null);
  const [statusCode, setStatusCode] = useState<number | null>(null);
  const [showEndpoint, setShowEndpoint] = useState(true);

  // Load user's API keys
  useEffect(() => {
    apiFetch("/api/apikeys").then(async r => {
      if (r.ok) {
        const keys = await r.json() as ApiKeyInfo[];
        setUserKeys(keys);
        if (keys.length > 0 && !apiKey) {
          // Don't pre-fill the actual key — it's masked. User must go to dashboard to copy the full key.
        }
      }
    }).catch(() => {});
  }, []);

  const parsedMessages = (() => { try { return JSON.parse(messages); } catch { return null; } })();
  const isValidJson = parsedMessages !== null;

  const handleExecute = async () => {
    if (!apiKey) { toast.error("Enter your API key first. Get one from the Dashboard."); return; }
    if (!isValidJson) { toast.error("Invalid JSON in messages field"); return; }
    if (!apiKey.startsWith("sk-dzcx")) { toast.error("Invalid API key format — must start with sk-dzcx"); return; }

    const finalMessages = systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...parsedMessages]
      : parsedMessages;

    setLoading(true);
    setResponse(null);
    setResponseTime(null);
    setStatusCode(null);

    const start = Date.now();
    try {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: finalMessages,
          temperature: parseFloat(temperature) || 0.7,
        }),
      });
      const elapsed = Date.now() - start;
      setResponseTime(elapsed);
      setStatusCode(res.status);
      const data = await res.json();
      setResponse(data);
      if (!res.ok) {
        const err = (data as { error?: { message?: string } }).error?.message;
        toast.error(err ?? "Request failed");
      }
    } catch (err) {
      setResponseTime(Date.now() - start);
      setStatusCode(0);
      setResponse({ error: { message: "Connection error", type: "connection_error" } });
      toast.error("Connection error");
    } finally {
      setLoading(false);
    }
  };

  const endpoint = `${window.location.protocol}//${window.location.host}${BASE}/v1/chat/completions`;
  const curlStr = `curl -X POST '${endpoint}' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer ${apiKey || "<YOUR_API_KEY>"}' \\
  -d '${JSON.stringify({
    model,
    messages: [{ role: "user", content: "Hello!" }],
    temperature: parseFloat(temperature) || 0.7,
  }, null, 2).replace(/\n/g, "\n  ")}'`;

  const statusCls = statusCode === null ? "" : statusCode >= 200 && statusCode < 300 ? "status-2xx" : "status-4xx";

  // Extract content from response for easy reading
  const assistantContent = response && typeof response === "object"
    ? ((response as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? null)
    : null;

  return (
    <div className="flex-1 flex flex-col overflow-auto">
      {/* Header */}
      <div className="bg-card border-b border-border px-4 sm:px-6 py-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-bold text-foreground">API Playground</h1>
              <span className="text-xs px-2 py-0.5 bg-muted text-muted-foreground border border-border rounded font-medium">OpenAI-compatible</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 font-mono">{endpoint}</p>
          </div>
          <div className="text-xs text-muted-foreground">Signed in as <span className="font-medium text-foreground">{user?.name}</span></div>
        </div>
      </div>

      <div className="flex-1 p-3 sm:p-6 max-w-5xl mx-auto w-full space-y-4">

        {/* Endpoint block */}
        <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          <button
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors text-left"
            onClick={() => setShowEndpoint(p => !p)}
          >
            <span className="method-badge-post">POST</span>
            <span className="font-mono text-sm font-medium text-foreground flex-1">/v1/chat/completions</span>
            <span className="hidden sm:block text-xs text-muted-foreground">Chat Completions</span>
            {showEndpoint ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
          </button>

          {showEndpoint && (
            <div className="border-t border-border">
              {/* API Key warning */}
              {userKeys.length === 0 && (
                <div className="px-4 py-3 bg-muted border-b border-border flex items-center gap-2 text-sm text-muted-foreground">
                  <Key className="w-4 h-4 shrink-0" />
                  <span>No API keys found. </span>
                  <Link href="/dashboard" className="font-semibold text-foreground underline">Create one in Dashboard →</Link>
                </div>
              )}

              <div className="px-3 sm:px-5 pt-4 pb-6 space-y-5">
                {/* Authorization */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <h3 className="text-sm font-semibold text-foreground">Authorization</h3>
                    <span className="text-xs px-1.5 py-0.5 bg-muted text-muted-foreground rounded font-semibold border border-border">required</span>
                  </div>
                  <div className="border border-border rounded-lg overflow-hidden">
                    <div className="bg-muted/60 flex flex-col sm:grid sm:grid-cols-[160px_1fr]">
                      <div className="px-4 py-3 sm:border-r sm:border-border border-b border-border/50 sm:border-b-0 bg-muted/30">
                        <div className="font-mono text-sm font-semibold">Authorization</div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">Bearer token (header)</div>
                      </div>
                      <div className="px-4 py-3 space-y-2">
                        <div className="text-xs text-muted-foreground">Your API key from the Dashboard (starts with <code className="bg-muted px-1 rounded">sk-dzcx</code>)</div>
                        <input
                          type="password"
                          value={apiKey}
                          onChange={e => setApiKey(e.target.value)}
                          placeholder="sk-dzcxXXXXXXXXXXXXXXXXXXXX"
                          className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
                        />
                        {userKeys.length > 0 && (
                          <div className="text-[11px] text-muted-foreground">
                            Your keys: {userKeys.map(k => (
                              <span key={k.id} className="font-mono">{maskKey(k.prefix, k.suffix)}</span>
                            )).reduce((a, b) => <>{a}, {b}</>)}
                            {" "}— copy the full key from <Link href="/dashboard" className="text-primary underline">Dashboard</Link>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Request body */}
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-3">Request body</h3>
                  <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
                    {/* model */}
                    <div className="flex flex-col sm:grid sm:grid-cols-[160px_1fr]">
                      <div className="px-4 py-3 sm:border-r border-border border-b sm:border-b-0 bg-muted/30">
                        <div className="font-mono text-sm font-semibold">model</div>
                        <div className="text-[11px] text-muted-foreground font-semibold">* required</div>
                        <div className="text-[11px] text-muted-foreground">string</div>
                      </div>
                      <div className="px-4 py-3 space-y-1.5">
                        <div className="text-xs text-muted-foreground">Model ID to use for completion</div>
                        <select
                          value={model}
                          onChange={e => setModel(e.target.value)}
                          className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors"
                        >
                          {MODEL_GROUPS.map(group => (
                            <optgroup key={group} label={group}>
                              {WORKING_MODELS.filter(m => m.group === group).map(m => (
                                <option key={m.id} value={m.id}>{m.label}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* system */}
                    <div className="flex flex-col sm:grid sm:grid-cols-[160px_1fr] bg-muted/10">
                      <div className="px-4 py-3 sm:border-r border-border border-b sm:border-b-0 bg-muted/20">
                        <div className="font-mono text-sm font-semibold">system</div>
                        <div className="text-[11px] text-muted-foreground">string (optional)</div>
                      </div>
                      <div className="px-4 py-3 space-y-1.5">
                        <div className="text-xs text-muted-foreground">System prompt — injected as first message with role "system"</div>
                        <input
                          type="text"
                          value={systemPrompt}
                          onChange={e => setSystemPrompt(e.target.value)}
                          placeholder="You are a helpful assistant."
                          className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors"
                        />
                      </div>
                    </div>

                    {/* messages */}
                    <div className="flex flex-col sm:grid sm:grid-cols-[160px_1fr]">
                      <div className="px-4 py-3 sm:border-r border-border border-b sm:border-b-0 bg-muted/30">
                        <div className="font-mono text-sm font-semibold">messages</div>
                        <div className="text-[11px] text-muted-foreground font-semibold">* required</div>
                        <div className="text-[11px] text-muted-foreground">array[object]</div>
                      </div>
                      <div className="px-4 py-3 space-y-2">
                        <div className="text-xs text-muted-foreground">
                          Array of <code className="bg-muted px-1 rounded text-[11px]">{"{ role, content }"}</code> — roles: <code className="bg-muted px-1 rounded text-[11px]">user</code>, <code className="bg-muted px-1 rounded text-[11px]">assistant</code>, <code className="bg-muted px-1 rounded text-[11px]">system</code>
                        </div>
                        <textarea
                          value={messages}
                          onChange={e => setMessages(e.target.value)}
                          rows={5}
                          spellCheck={false}
                          className={`w-full border rounded-lg px-3 py-2 text-sm font-mono bg-background resize-y focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors ${isValidJson ? "border-border focus:border-primary" : "border-red-400 focus:ring-red-200"}`}
                        />
                        {!isValidJson && <div className="text-xs text-red-600">Invalid JSON</div>}
                        <div className="flex gap-2">
                          <button
                            onClick={() => { try { const m = JSON.parse(messages); m.push({ role: "user", content: "" }); setMessages(JSON.stringify(m, null, 2)); } catch { toast.error("Fix JSON first"); } }}
                            className="text-xs px-2 py-1 border border-border rounded hover:bg-muted transition-colors"
                          >+ user</button>
                          <button
                            onClick={() => { try { const m = JSON.parse(messages); m.push({ role: "assistant", content: "" }); setMessages(JSON.stringify(m, null, 2)); } catch { toast.error("Fix JSON first"); } }}
                            className="text-xs px-2 py-1 border border-border rounded hover:bg-muted transition-colors"
                          >+ assistant</button>
                        </div>
                      </div>
                    </div>

                    {/* temperature */}
                    <div className="flex flex-col sm:grid sm:grid-cols-[160px_1fr] bg-muted/10">
                      <div className="px-4 py-3 sm:border-r border-border border-b sm:border-b-0 bg-muted/20">
                        <div className="font-mono text-sm font-semibold">temperature</div>
                        <div className="text-[11px] text-muted-foreground">number (optional)</div>
                      </div>
                      <div className="px-4 py-3 space-y-1.5">
                        <div className="text-xs text-muted-foreground">Sampling temperature 0–2. Default 0.7</div>
                        <input
                          type="number"
                          min="0" max="2" step="0.1"
                          value={temperature}
                          onChange={e => setTemperature(e.target.value)}
                          className="w-32 border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Execute buttons */}
                <div className="flex gap-3">
                  <button
                    onClick={handleExecute}
                    disabled={loading || !isValidJson}
                    className="flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground text-sm font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                    Execute
                  </button>
                  <button
                    onClick={() => { setResponse(null); setResponseTime(null); setStatusCode(null); }}
                    className="px-6 py-2.5 border border-border text-sm font-semibold rounded-lg hover:bg-muted transition-colors"
                  >
                    Clear
                  </button>
                </div>

                {/* Response section */}
                {(response !== null || loading) && (
                  <div className="space-y-4 pt-2 border-t border-border">
                    <h3 className="text-sm font-semibold text-foreground">Responses</h3>

                    {/* curl */}
                    <div>
                      <div className="text-xs text-muted-foreground mb-1.5 font-medium uppercase tracking-wider">Curl</div>
                      <CodeBlock content={curlStr} />
                    </div>

                    {/* Request URL */}
                    <div>
                      <div className="text-xs text-muted-foreground mb-1.5 font-medium uppercase tracking-wider">Request URL</div>
                      <div className="bg-muted border border-border text-muted-foreground rounded-lg px-4 py-2.5 text-xs font-mono break-all">{endpoint}</div>
                    </div>

                    {/* Server response */}
                    <div>
                      <div className="text-xs text-muted-foreground mb-1.5 font-medium uppercase tracking-wider">Server response</div>
                      {loading ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                          <Loader2 className="w-4 h-4 animate-spin" /> Awaiting response...
                        </div>
                      ) : (
                        <div className="border border-border rounded-lg overflow-hidden">
                          <div className="hidden sm:grid sm:grid-cols-[80px_1fr] bg-muted text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            <div className="px-4 py-2 border-r border-border">Code</div>
                            <div className="px-4 py-2">Details</div>
                          </div>
                          <div className="sm:grid sm:grid-cols-[80px_1fr] border-t border-border">
                            <div className="px-4 py-3 sm:border-r sm:border-border flex items-center gap-2 border-b border-border sm:border-b-0">
                              <span className={statusCls}>{statusCode ?? "—"}</span>
                            </div>
                            <div className="px-4 py-3 space-y-3">
                              {assistantContent && (
                                <div className="bg-muted border border-border rounded-lg px-3 py-2.5">
                                  <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Assistant reply</div>
                                  <div className="text-sm text-foreground whitespace-pre-wrap">{assistantContent}</div>
                                </div>
                              )}
                              <div className="flex items-center justify-between">
                                <div className="text-xs text-muted-foreground font-medium">Full response body {responseTime !== null && <span className="ml-2 text-foreground/70">{responseTime}ms</span>}</div>
                                <button
                                  onClick={() => { navigator.clipboard.writeText(JSON.stringify(response, null, 2)); toast.success("Copied"); }}
                                  className="text-xs px-2 py-0.5 border border-border rounded hover:bg-muted transition-colors"
                                >Copy</button>
                              </div>
                              <div className="code-block overflow-x-auto" dangerouslySetInnerHTML={{ __html: syntaxHighlight(JSON.stringify(response, null, 2)) }} />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Models endpoint */}
        <ModelsBlock apiKey={apiKey} />

        {/* Image generations endpoint */}
        <ImageGenerationsBlock apiKey={apiKey} />

      </div>
    </div>
  );
}
