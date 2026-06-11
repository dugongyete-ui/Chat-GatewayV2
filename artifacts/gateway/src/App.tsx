import React from "react";
import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Playground from "@/pages/playground";
import History from "@/pages/history";
import Stats from "@/pages/stats";
import Dashboard from "@/pages/dashboard";
import Login from "@/pages/login";
import Register from "@/pages/register";
import Landing from "@/pages/landing";
import Layout from "@/components/layout";
import { isAuthenticated } from "@/lib/auth";

const queryClient = new QueryClient();

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
            fontFamily: "system-ui, sans-serif",
            background: "#f9fafb",
          }}
        >
          <div
            style={{
              maxWidth: 600,
              background: "#fff",
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              padding: "2rem",
              boxShadow: "0 1px 4px rgba(0,0,0,.08)",
            }}
          >
            <h1 style={{ color: "#dc2626", margin: "0 0 1rem", fontSize: "1.25rem" }}>
              Application Error
            </h1>
            <p style={{ color: "#374151", margin: "0 0 0.5rem" }}>
              <strong>{this.state.error?.name}:</strong> {this.state.error?.message}
            </p>
            {this.state.error?.stack && (
              <pre
                style={{
                  background: "#f3f4f6",
                  borderRadius: 8,
                  padding: "1rem",
                  fontSize: "0.75rem",
                  overflowX: "auto",
                  whiteSpace: "pre-wrap",
                  color: "#6b7280",
                  margin: "1rem 0 0",
                }}
              >
                {this.state.error.stack}
              </pre>
            )}
            <button
              onClick={() => window.location.reload()}
              style={{
                marginTop: "1.5rem",
                padding: "0.5rem 1.25rem",
                background: "#3b82f6",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: "0.875rem",
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  if (!isAuthenticated()) return <Redirect to="/login" />;
  return <Component />;
}

function PublicOnlyRoute({ component: Component }: { component: React.ComponentType }) {
  if (isAuthenticated()) return <Redirect to="/dashboard" />;
  return <Component />;
}

function Router() {
  const [location] = useLocation();
  const isAuthPage = location === "/login" || location === "/register";
  const isLandingPage = location === "/";

  if (isAuthPage) {
    return (
      <Switch>
        <Route path="/login" component={() => <PublicOnlyRoute component={Login} />} />
        <Route path="/register" component={() => <PublicOnlyRoute component={Register} />} />
      </Switch>
    );
  }

  if (isLandingPage && !isAuthenticated()) {
    return (
      <Switch>
        <Route path="/" component={Landing} />
      </Switch>
    );
  }

  return (
    <Layout>
      <Switch>
        <Route path="/" component={() => <ProtectedRoute component={Dashboard} />} />
        <Route path="/dashboard" component={() => <ProtectedRoute component={Dashboard} />} />
        <Route path="/playground" component={() => <ProtectedRoute component={Playground} />} />
        <Route path="/history" component={() => <ProtectedRoute component={History} />} />
        <Route path="/stats" component={() => <ProtectedRoute component={Stats} />} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
