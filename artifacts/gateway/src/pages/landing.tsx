import { Link } from "wouter";
import { useState, useEffect, useRef } from "react";
import {
  Copy, Check, ChevronRight, ArrowRight,
  Zap, Shield, Globe, Code2, Layers, Infinity,
  Menu, X, Terminal, Cpu
} from "lucide-react";

const MODELS = [
  { id: "command-a",            label: "Cohere Command A",      badge: "Flagship"  },
  { id: "command-r-plus",       label: "Cohere Command R+",     badge: "Advanced"  },
  { id: "aria",                 label: "Opera Aria",            badge: "OpenAI"    },
  { id: "kimi-k2",              label: "Kimi K2",               badge: "Moonshot"  },
  { id: "kimi-search",          label: "Kimi Search",           badge: "Web"       },
  { id: "gptfree-pro",          label: "GPTFree Pro",           badge: "Free"      },
  { id: "algochat",             label: "AlgoChat (Gemini)",     badge: "Google"    },
  { id: "yqcloud",              label: "YQCloud GPT-4",         badge: "GPT-4"     },
];

const FEATURES = [
  { icon: <Code2 size={16} />,    title: "OpenAI-Compatible API",  desc: "Drop-in replacement for OpenAI. Works with Python SDK, Node.js, LangChain, AutoGen, and more." },
  { icon: <Layers size={16} />,   title: "8 AI Providers",         desc: "Cohere, Opera Aria, Kimi, GPTFree, AlgoChat, YQCloud — one endpoint, all models." },
  { icon: <Zap size={16} />,      title: "Smart Alias Routing",    desc: "Use familiar names like qwen-plus or qwen-max — automatically routed to the best available model." },
  { icon: <Shield size={16} />,   title: "API Key Auth",           desc: "Secure access with API keys. Create, revoke, and manage keys from your dashboard." },
  { icon: <Globe size={16} />,    title: "SSE Streaming",          desc: "Full server-sent events streaming for real-time token-by-token output in any application." },
  { icon: <Infinity size={16} />, title: "50 MB Payload Limit",   desc: "Designed for AI agents sending long conversation histories and large tool results." },
];

const BADGES = [
  { icon: <Zap size={13} />,      label: "Automatic retries" },
  { icon: <Shield size={13} />,   label: "One API key" },
  { icon: <Layers size={13} />,   label: "8 AI providers" },
  { icon: <Code2 size={13} />,    label: "OpenAI SDK compatible" },
  { icon: <Globe size={13} />,    label: "Streaming support" },
  { icon: <Terminal size={13} />, label: "50 MB payload limit" },
];

const mkCurl = (base: string) =>
`curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "command-a",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`;

const mkPython = (base: string) =>
`from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="${base}/v1"
)

response = client.chat.completions.create(
    model="command-a",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)`;

const mkNode = (base: string) =>
`import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "YOUR_API_KEY",
  baseURL: "${base}/v1",
});

const response = await client.chat.completions.create({
  model: "command-a",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.choices[0].message.content);`;

function StarField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    const resize = () => { c.width = c.offsetWidth; c.height = c.offsetHeight; };
    resize(); window.addEventListener("resize", resize);
    const stars = Array.from({ length: 150 }, () => ({
      x: Math.random() * c.width, y: Math.random() * c.height,
      r: Math.random() * 1.1 + 0.2, o: Math.random() * 0.6 + 0.1,
      sp: Math.random() * 0.3 + 0.05,
    }));
    let f = 0, raf: number;
    const draw = () => {
      ctx.clearRect(0, 0, c.width, c.height); f++;
      for (const s of stars) {
        const o = s.o + Math.sin(f * s.sp * 0.07 + s.x) * 0.15;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${Math.max(0, Math.min(1, o))})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { window.removeEventListener("resize", resize); cancelAnimationFrame(raf); };
  }, []);
  return <canvas ref={ref} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", opacity: 0.45 }} />;
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text).catch(() => {}); setOk(true); setTimeout(() => setOk(false), 2000); }}
      style={{ position: "absolute", top: 12, right: 12, padding: "6px 7px", borderRadius: 7, border: "none", cursor: "pointer", background: "rgba(255,255,255,0.06)", color: ok ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.3)", display: "flex", alignItems: "center" }}>
      {ok ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

const hov = (el: HTMLElement, on: boolean) => {
  el.style.borderColor = on ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.07)";
  el.style.background = on ? "#13131f" : "#0f0f1c";
};

export default function Landing() {
  const [base, setBase] = useState("https://your-domain.com");
  const [tab, setTab] = useState<"Python" | "Node.js" | "cURL">("Python");
  const [nav, setNav] = useState(false);

  useEffect(() => { setBase(window.location.origin); }, []);

  const snippets: Record<string, string> = {
    Python: mkPython(base), "Node.js": mkNode(base), cURL: mkCurl(base),
  };

  const D = "#08080f";
  const CARD = "#0f0f1c";
  const BORDER = "rgba(255,255,255,0.08)";
  const DIM = "rgba(255,255,255,0.38)";
  const MID = "rgba(255,255,255,0.55)";

  return (
    <div style={{ background: D, color: "#fff", fontFamily: "'Inter',system-ui,sans-serif", minHeight: "100vh" }}>

      {/* Announcement bar */}
      <div style={{ background: "rgba(255,255,255,0.03)", borderBottom: `1px solid ${BORDER}`, padding: "8px 16px", textAlign: "center", fontSize: "0.77rem", color: DIM }}>
        Cohere · Aria · Kimi · GPTFree · AlgoChat · OpenAI-compatible
        <Link href="/register" style={{ marginLeft: 10, color: "rgba(255,255,255,0.65)", fontWeight: 600, textDecoration: "none" }}>Get started →</Link>
      </div>

      {/* Navbar */}
      <nav style={{ position: "sticky", top: 0, zIndex: 50, background: "rgba(8,8,15,0.9)", backdropFilter: "blur(16px)", borderBottom: `1px solid ${BORDER}`, height: 58, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <div style={{ width: 28, height: 28, borderRadius: 7, background: "rgba(255,255,255,0.08)", border: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.8rem", fontWeight: 800, color: "#fff" }}>D</div>
          <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>Dzeck API AI</span>
        </div>

        <div className="hidden md:flex" style={{ gap: 26, fontSize: "0.83rem", color: DIM }}>
          {["#models:Models", "#quickstart:Quickstart", "#features:Features"].map(s => {
            const [href, label] = s.split(":");
            return <a key={href} href={href} style={{ color: "inherit", textDecoration: "none" }}
              onMouseEnter={e => (e.currentTarget.style.color = "#fff")}
              onMouseLeave={e => (e.currentTarget.style.color = DIM)}>{label}</a>;
          })}
        </div>

        <div className="hidden md:flex" style={{ alignItems: "center", gap: 8 }}>
          <Link href="/login" style={{ fontSize: "0.83rem", color: DIM, textDecoration: "none", padding: "6px 14px" }}
            onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => (e.currentTarget.style.color = "#fff")}
            onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => (e.currentTarget.style.color = DIM)}>Sign in</Link>
          <Link href="/register" style={{ fontSize: "0.83rem", fontWeight: 700, color: D, background: "#fff", borderRadius: 20, padding: "7px 18px", textDecoration: "none" }}>Get started</Link>
        </div>

        <button className="md:hidden" onClick={() => setNav(v => !v)} style={{ background: "none", border: "none", color: MID, cursor: "pointer", padding: 4 }}>
          {nav ? <X size={20} /> : <Menu size={20} />}
        </button>
      </nav>

      {nav && (
        <div style={{ background: "#0c0c18", borderBottom: `1px solid ${BORDER}`, padding: "16px 24px", display: "flex", flexDirection: "column", gap: 14, fontSize: "0.88rem" }}>
          <a href="#models" onClick={() => setNav(false)} style={{ color: MID, textDecoration: "none" }}>Models</a>
          <a href="#quickstart" onClick={() => setNav(false)} style={{ color: MID, textDecoration: "none" }}>Quickstart</a>
          <a href="#features" onClick={() => setNav(false)} style={{ color: MID, textDecoration: "none" }}>Features</a>
          <div style={{ display: "flex", gap: 8, paddingTop: 6 }}>
            <Link href="/login" style={{ flex: 1, textAlign: "center", padding: "9px", border: `1px solid ${BORDER}`, borderRadius: 10, color: MID, textDecoration: "none", fontSize: "0.84rem" }}>Sign in</Link>
            <Link href="/register" style={{ flex: 1, textAlign: "center", padding: "9px", background: "#fff", borderRadius: 10, color: D, textDecoration: "none", fontWeight: 700, fontSize: "0.84rem" }}>Get started</Link>
          </div>
        </div>
      )}

      {/* Hero */}
      <section style={{ position: "relative", overflow: "hidden", paddingTop: 96, paddingBottom: 96, textAlign: "center" }}>
        <StarField />
        <div style={{ position: "absolute", top: "5%", left: "50%", transform: "translateX(-50%)", width: 640, height: 380, background: "radial-gradient(ellipse,rgba(255,255,255,0.03) 0%,transparent 70%)", pointerEvents: "none" }} />

        <div style={{ position: "relative", maxWidth: 680, margin: "0 auto", padding: "0 20px" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,0.04)", border: `1px solid ${BORDER}`, borderRadius: 99, padding: "6px 16px", marginBottom: 32, fontSize: "0.76rem", color: DIM }}>
            <Cpu size={12} style={{ opacity: 0.5 }} />
            8 AI providers · OpenAI-compatible · No API key needed
          </div>

          <h1 style={{ fontSize: "clamp(2.2rem,6vw,3.8rem)", fontWeight: 800, lineHeight: 1.08, letterSpacing: "-0.03em", marginBottom: 22, color: "#fff" }}>
            One API.{" "}
            <span style={{ color: "rgba(255,255,255,0.55)" }}>Every AI Model.</span>
          </h1>

          <p style={{ fontSize: "1rem", color: DIM, lineHeight: 1.75, maxWidth: 460, margin: "0 auto 40px" }}>
            One endpoint, all models — Cohere, Aria, Kimi, GPTFree, and more. Switch instantly, no lock-in.
            Drop-in replacement for any OpenAI-compatible client.
          </p>

          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap", marginBottom: 52 }}>
            <Link href="/register" style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "#fff", color: D, padding: "12px 26px", borderRadius: 11, fontWeight: 700, fontSize: "0.875rem", textDecoration: "none" }}>
              <Cpu size={15} /> Go to Dashboard
            </Link>
            <a href="#quickstart" style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "rgba(255,255,255,0.04)", border: `1px solid rgba(255,255,255,0.11)`, color: "rgba(255,255,255,0.7)", padding: "12px 26px", borderRadius: 11, fontWeight: 600, fontSize: "0.875rem", textDecoration: "none" }}>
              Documentation <ArrowRight size={14} />
            </a>
          </div>

          <div style={{ display: "flex", gap: 20, justifyContent: "center", flexWrap: "wrap" }}>
            {BADGES.map(b => (
              <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.74rem", color: "rgba(255,255,255,0.3)" }}>
                <span style={{ opacity: 0.5 }}>{b.icon}</span>{b.label}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Code block */}
      <section id="quickstart" style={{ padding: "0 20px 80px", maxWidth: 680, margin: "0 auto" }}>
        <div style={{ border: `1px solid rgba(255,255,255,0.09)`, borderRadius: 16, overflow: "hidden", background: "#0d0d1c" }}>
          <div style={{ padding: "11px 16px", borderBottom: `1px solid rgba(255,255,255,0.07)`, display: "flex", alignItems: "center", gap: 12, background: "#0f0f20" }}>
            <div style={{ display: "flex", gap: 6 }}>
              {["#ff5f57","#febc2e","#28c840"].map(c => <span key={c} style={{ width: 12, height: 12, borderRadius: "50%", background: c, display: "block" }} />)}
            </div>
            <div style={{ display: "flex", gap: 2, marginLeft: 6 }}>
              {(["Python","Node.js","cURL"] as const).map(t => (
                <button key={t} onClick={() => setTab(t)} style={{ padding: "4px 13px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: "0.78rem", fontWeight: 600, background: tab === t ? "rgba(255,255,255,0.1)" : "transparent", color: tab === t ? "#fff" : DIM }}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div style={{ position: "relative", padding: "20px 22px" }}>
            <CopyBtn text={snippets[tab]} />
            <pre style={{ margin: 0, fontSize: "0.81rem", lineHeight: 1.75, color: "rgba(255,255,255,0.75)", fontFamily: "'JetBrains Mono','Fira Code',Menlo,monospace", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {snippets[tab]}
            </pre>
          </div>
        </div>
        <div style={{ marginTop: 14, textAlign: "center", fontSize: "0.76rem", color: "rgba(255,255,255,0.25)" }}>
          base_url — <code style={{ color: "rgba(255,255,255,0.45)", fontFamily: "monospace" }}>{base}/v1</code>
        </div>
      </section>

      <div style={{ height: 1, background: `linear-gradient(90deg,transparent,${BORDER},transparent)`, maxWidth: 680, margin: "0 auto" }} />

      {/* Models */}
      <section id="models" style={{ padding: "72px 20px", maxWidth: 900, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 44 }}>
          <h2 style={{ fontSize: "clamp(1.5rem,4vw,2.2rem)", fontWeight: 800, letterSpacing: "-0.025em", color: "#fff", marginBottom: 12 }}>Available Models</h2>
          <p style={{ color: DIM, fontSize: "0.9rem", maxWidth: 480, margin: "0 auto" }}>
            All models via a single endpoint. Use exact model IDs like{" "}
            <code style={{ color: "rgba(255,255,255,0.6)", fontFamily: "monospace" }}>command-a</code>,{" "}
            <code style={{ color: "rgba(255,255,255,0.6)", fontFamily: "monospace" }}>kimi-k2</code>.
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))", gap: 10 }}>
          {MODELS.map(m => (
            <div key={m.id} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 13, padding: "15px 17px", transition: "border-color 0.2s,background 0.2s", cursor: "default" }}
              onMouseEnter={e => hov(e.currentTarget as HTMLElement, true)}
              onMouseLeave={e => hov(e.currentTarget as HTMLElement, false)}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
                <span style={{ fontWeight: 600, fontSize: "0.83rem", color: "#fff" }}>{m.label}</span>
                <span style={{ fontSize: "0.67rem", fontWeight: 600, padding: "2px 7px", borderRadius: 99, color: "rgba(255,255,255,0.5)", background: "rgba(255,255,255,0.06)", border: `1px solid rgba(255,255,255,0.09)` }}>{m.badge}</span>
              </div>
              <code style={{ fontSize: "0.7rem", color: "rgba(255,255,255,0.28)", fontFamily: "monospace", wordBreak: "break-all" }}>{m.id}</code>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section id="features" style={{ padding: "0 20px 80px", maxWidth: 900, margin: "0 auto" }}>
        <div style={{ height: 1, background: `linear-gradient(90deg,transparent,${BORDER},transparent)`, marginBottom: 68 }} />
        <div style={{ textAlign: "center", marginBottom: 44 }}>
          <h2 style={{ fontSize: "clamp(1.5rem,4vw,2.2rem)", fontWeight: 800, letterSpacing: "-0.025em", color: "#fff", marginBottom: 12 }}>Everything you need</h2>
          <p style={{ color: DIM, fontSize: "0.9rem" }}>Built for developers running autonomous AI agents and production workloads.</p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 14 }}>
          {FEATURES.map(f => (
            <div key={f.title} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 15, padding: "22px 22px", transition: "border-color 0.2s" }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.13)"}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = BORDER}
            >
              <div style={{ width: 36, height: 36, borderRadius: 9, background: "rgba(255,255,255,0.05)", border: `1px solid rgba(255,255,255,0.08)`, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 14, color: "rgba(255,255,255,0.55)" }}>
                {f.icon}
              </div>
              <h3 style={{ fontWeight: 700, fontSize: "0.9rem", color: "#fff", marginBottom: 8 }}>{f.title}</h3>
              <p style={{ fontSize: "0.8rem", color: DIM, lineHeight: 1.65, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section style={{ padding: "72px 20px", textAlign: "center", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at center,rgba(255,255,255,0.02) 0%,transparent 70%)", pointerEvents: "none" }} />
        <div style={{ position: "relative", maxWidth: 520, margin: "0 auto" }}>
          <h2 style={{ fontSize: "clamp(1.7rem,4vw,2.6rem)", fontWeight: 800, letterSpacing: "-0.03em", color: "#fff", marginBottom: 14 }}>Ready to build?</h2>
          <p style={{ color: DIM, fontSize: "0.95rem", marginBottom: 34, lineHeight: 1.65 }}>
            Free to get started. Works with every OpenAI-compatible library. No configuration required.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <Link href="/register" style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "#fff", color: D, padding: "12px 26px", borderRadius: 11, fontWeight: 700, fontSize: "0.875rem", textDecoration: "none" }}>
              Create free account <ChevronRight size={15} />
            </Link>
            <Link href="/login" style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "rgba(255,255,255,0.04)", border: `1px solid rgba(255,255,255,0.11)`, color: "rgba(255,255,255,0.7)", padding: "12px 26px", borderRadius: 11, fontWeight: 600, fontSize: "0.875rem", textDecoration: "none" }}>
              Sign in
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: `1px solid ${BORDER}`, padding: "26px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 14, maxWidth: 900, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 22, height: 22, borderRadius: 6, background: "rgba(255,255,255,0.07)", border: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.65rem", fontWeight: 800, color: "#fff" }}>D</div>
          <span style={{ fontWeight: 700, fontSize: "0.88rem" }}>Dzeck API AI</span>
        </div>
        <div style={{ fontSize: "0.73rem", color: "rgba(255,255,255,0.22)" }}>
          base_url: <code style={{ color: "rgba(255,255,255,0.4)", fontFamily: "monospace" }}>{base}/v1</code>
        </div>
        <div style={{ display: "flex", gap: 18, fontSize: "0.78rem" }}>
          <Link href="/login" style={{ color: "rgba(255,255,255,0.3)", textDecoration: "none" }}>Sign in</Link>
          <Link href="/register" style={{ color: "rgba(255,255,255,0.3)", textDecoration: "none" }}>Register</Link>
        </div>
      </footer>

    </div>
  );
}
