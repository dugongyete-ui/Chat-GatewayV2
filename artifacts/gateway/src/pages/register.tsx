import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { setAuth } from "@/lib/auth";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const S = {
  page: { minHeight: "100vh", background: "#08080f", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 16px", fontFamily: "'Inter',system-ui,sans-serif" } as React.CSSProperties,
  wrap: { width: "100%", maxWidth: 380 } as React.CSSProperties,
  logo: { display: "flex", flexDirection: "column" as const, alignItems: "center", marginBottom: 36 },
  logoMark: { width: 44, height: 44, borderRadius: 12, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16, fontSize: "1.1rem", fontWeight: 800, color: "#fff" },
  title: { fontSize: "1.35rem", fontWeight: 700, color: "#fff", margin: 0 },
  subtitle: { fontSize: "0.83rem", color: "rgba(255,255,255,0.38)", margin: "6px 0 0" },
  card: { background: "#0f0f1c", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "28px 24px" } as React.CSSProperties,
  label: { display: "block", fontSize: "0.8rem", fontWeight: 500, color: "rgba(255,255,255,0.55)", marginBottom: 7 },
  input: { width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "11px 14px", fontSize: "0.875rem", color: "#fff", outline: "none", boxSizing: "border-box" as const, transition: "border-color 0.15s" },
  inputFocus: { borderColor: "rgba(255,255,255,0.3)" },
  btn: { width: "100%", padding: "12px", background: "#fff", color: "#08080f", border: "none", borderRadius: 10, fontSize: "0.875rem", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "opacity 0.15s", marginTop: 8 } as React.CSSProperties,
  footer: { textAlign: "center" as const, marginTop: 20, fontSize: "0.82rem", color: "rgba(255,255,255,0.35)" },
  link: { color: "rgba(255,255,255,0.7)", fontWeight: 600, textDecoration: "none" },
};

export default function Register() {
  const [, navigate] = useLocation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) { toast.error("Password must be at least 6 characters"); return; }
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json() as { token?: string; user?: { id: string; name: string; email: string }; error?: string };
      if (!res.ok) { toast.error(data.error ?? "Registration failed"); return; }
      setAuth(data.token!, data.user!);
      toast.success("Account created! Welcome aboard.");
      navigate("/dashboard");
    } catch {
      toast.error("Connection error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={S.page}>
      <div style={S.wrap}>
        <div style={S.logo}>
          <div style={S.logoMark}>D</div>
          <h1 style={S.title}>Dzeck API AI</h1>
          <p style={S.subtitle}>Create your account</p>
        </div>

        <div style={S.card}>
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div>
              <label style={S.label}>Full name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                onFocus={() => setFocused("name")}
                onBlur={() => setFocused(null)}
                required
                autoComplete="name"
                placeholder="John Doe"
                style={{ ...S.input, ...(focused === "name" ? S.inputFocus : {}) }}
              />
            </div>

            <div>
              <label style={S.label}>Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onFocus={() => setFocused("email")}
                onBlur={() => setFocused(null)}
                required
                autoComplete="email"
                placeholder="you@example.com"
                style={{ ...S.input, ...(focused === "email" ? S.inputFocus : {}) }}
              />
            </div>

            <div>
              <label style={S.label}>Password</label>
              <div style={{ position: "relative" }}>
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onFocus={() => setFocused("password")}
                  onBlur={() => setFocused(null)}
                  required
                  autoComplete="new-password"
                  placeholder="Min. 6 characters"
                  style={{ ...S.input, paddingRight: 44, ...(focused === "password" ? S.inputFocus : {}) }}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(p => !p)}
                  style={{ position: "absolute", right: 13, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.3)", padding: 0, display: "flex", alignItems: "center" }}
                >
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{ ...S.btn, opacity: loading ? 0.6 : 1, cursor: loading ? "not-allowed" : "pointer" }}
            >
              {loading && <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} />}
              Create account
            </button>
          </form>
        </div>

        <p style={S.footer}>
          Already have an account?{" "}
          <Link href="/login" style={S.link}>Sign in</Link>
        </p>

        <p style={{ ...S.footer, marginTop: 10 }}>
          <Link href="/" style={{ ...S.link, fontWeight: 400, color: "rgba(255,255,255,0.25)" }}>← Back to home</Link>
        </p>
      </div>
    </div>
  );
}
