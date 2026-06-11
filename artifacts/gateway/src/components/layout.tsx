import { useState } from "react";
import { Link, useLocation } from "wouter";
import { LayoutGrid, History, BarChart3, Key, Menu, X, LogOut, User, Activity } from "lucide-react";
import { useHealthCheck } from "@workspace/api-client-react";
import { getUser, clearAuth } from "@/lib/auth";

const navItems = [
  { href: "/dashboard",   label: "Dashboard",      icon: Key },
  { href: "/playground",  label: "API Playground",  icon: LayoutGrid },
  { href: "/history",     label: "Request History", icon: History },
  { href: "/stats",       label: "Statistics",      icon: BarChart3 },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { data: health } = useHealthCheck();
  const isHealthy = health?.status === "ok";
  const user = getUser();

  const handleLogout = () => { clearAuth(); navigate("/login"); };

  const NavLinks = ({ onNav }: { onNav?: () => void }) => (
    <>
      {navItems.map((item) => {
        const active = location === item.href || (item.href === "/dashboard" && location === "/");
        return (
          <Link key={item.href} href={item.href}>
            <div
              onClick={onNav}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm transition-colors cursor-pointer ${
                active
                  ? "bg-accent text-foreground font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              <span>{item.label}</span>
            </div>
          </Link>
        );
      })}
    </>
  );

  const UserSection = () => (
    <div className="p-3 border-t border-border space-y-1">
      <div className="flex items-center gap-2.5 px-3 py-2 rounded-md">
        <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center shrink-0">
          <User className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-foreground truncate">{user?.name ?? "User"}</div>
          <div className="text-[10px] text-muted-foreground truncate">{user?.email}</div>
        </div>
      </div>
      <button
        onClick={handleLogout}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
      >
        <LogOut className="w-4 h-4 shrink-0" />
        <span>Sign out</span>
      </button>
      <div className="flex items-center gap-2 text-xs text-muted-foreground px-3 py-1">
        <Activity className="w-3.5 h-3.5 shrink-0" />
        <span>Gateway</span>
        <div className={`ml-auto w-2 h-2 rounded-full ${isHealthy ? "bg-foreground/60" : "bg-destructive/60"}`} />
      </div>
    </div>
  );

  const Logo = () => (
    <div className="flex items-center gap-2.5">
      <div className="w-7 h-7 rounded-md bg-muted border border-border flex items-center justify-center shrink-0 text-xs font-bold text-foreground">D</div>
      <div>
        <div className="font-semibold text-sm leading-tight text-foreground">Dzeck API AI</div>
        <div className="text-[11px] text-muted-foreground leading-tight">OpenAI-compatible</div>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-56 border-r border-border bg-card flex-col shrink-0">
        <div className="h-14 flex items-center px-4 border-b border-border">
          <Logo />
        </div>
        <nav className="flex-1 py-3 px-3 flex flex-col gap-0.5 overflow-y-auto">
          <NavLinks />
        </nav>
        <UserSection />
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={() => setMobileOpen(false)} />}

      {/* Mobile drawer */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-card border-r border-border flex flex-col md:hidden transform transition-transform duration-200 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="h-14 flex items-center justify-between px-4 border-b border-border">
          <Logo />
          <button onClick={() => setMobileOpen(false)} className="p-1.5 rounded-md hover:bg-muted transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
        <nav className="flex-1 py-3 px-3 flex flex-col gap-0.5 overflow-y-auto">
          <NavLinks onNav={() => setMobileOpen(false)} />
        </nav>
        <UserSection />
      </aside>

      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile top bar */}
        <div className="md:hidden h-14 flex items-center gap-3 px-4 border-b border-border bg-card shrink-0">
          <button onClick={() => setMobileOpen(true)} className="p-2 rounded-md hover:bg-muted transition-colors">
            <Menu className="w-5 h-5 text-muted-foreground" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-muted border border-border flex items-center justify-center text-xs font-bold">D</div>
            <span className="font-semibold text-sm">Dzeck API AI</span>
          </div>
          <button onClick={handleLogout} className="ml-auto p-2 rounded-md hover:bg-muted transition-colors text-muted-foreground">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
        <main className="flex-1 overflow-auto flex flex-col">{children}</main>
      </div>
    </div>
  );
}
