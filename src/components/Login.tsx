import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { Sun, Moon, Mail, Lock, ArrowRight } from "lucide-react";

export const Login: React.FC = () => {
  const [authMode, setAuthMode] = useState<"login" | "signup" | "otp">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  
  const setSession = useStore((state) => state.setSession);
  const theme = useStore((state) => state.theme);
  const toggleTheme = useStore((state) => state.toggleTheme);

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setIsSending(true);
    setMessage(null);
    
    try {
      await invoke("supabase_login_with_otp", { email });
      setMessage({ text: "Magic Link sent! Please check your email inbox.", type: "success" });
    } catch (e: any) {
      const errorText = typeof e === "string" ? e : (e?.message || "Failed to send magic link.");
      setMessage({ text: errorText, type: "error" });
    } finally {
      setIsSending(false);
    }
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setIsSending(true);
    setMessage(null);

    try {
      const user = await invoke<any>("supabase_login", { email, password });
      setSession({ user });
    } catch (e: any) {
      const errorText = typeof e === "string" ? e : (e?.message || "Login failed. Check your credentials.");
      setMessage({ text: errorText, type: "error" });
    } finally {
      setIsSending(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    if (password !== confirmPassword) {
      setMessage({ text: "Passwords do not match.", type: "error" });
      return;
    }
    setIsSending(true);
    setMessage(null);

    try {
      await invoke<any>("supabase_signup", { email, password });
      
      // Attempt to auto-retrieve session if confirmation is off
      const sessionUser = await invoke<any>("get_supabase_session");
      if (sessionUser) {
        setSession({ user: sessionUser });
      } else {
        setMessage({ 
          text: "Registration successful! Check your email inbox to verify your account before logging in.", 
          type: "success" 
        });
        setAuthMode("login");
        setPassword("");
        setConfirmPassword("");
      }
    } catch (e: any) {
      const errorText = typeof e === "string" ? e : (e?.message || "Signup failed.");
      setMessage({ text: errorText, type: "error" });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4 transition-colors duration-200 relative font-sans">
      {/* Theme Toggle Button top right */}
      <button
        onClick={toggleTheme}
        className="absolute top-6 right-6 p-2 rounded-lg bg-surface border border-border text-text-secondary hover:text-text hover:bg-surface2 transition-all shadow-sm"
        title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
      >
        {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </button>

      <div className="w-full max-w-md bg-surface border border-border rounded-xl p-8 shadow-xl transition-all">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-accent flex items-center justify-center mb-3 shadow-md shadow-accent/10">
            <span className="text-xl font-extrabold text-accent-contrast">Ω</span>
          </div>
          <h1 className="text-2xl font-bold text-text tracking-tight">
            {authMode === "login" && "Sign in to Omni"}
            {authMode === "signup" && "Create your account"}
            {authMode === "otp" && "Passwordless Sign In"}
          </h1>
          <p className="text-text-secondary text-xs mt-1">Your secure AI desktop agent</p>
        </div>

        {message && (
          <div className={`p-4 rounded-lg mb-6 border text-xs font-semibold leading-relaxed transition-all ${
            message.type === "success" 
              ? "bg-success/10 border-success/30 text-success" 
              : "bg-error/10 border-error/30 text-error"
          }`}>
            <p>{message.text}</p>
          </div>
        )}

        {authMode === "login" && (
          <form onSubmit={handlePasswordLogin} className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-2">
                Email Address
              </label>
              <div className="relative">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full pl-10 pr-4 py-3 bg-surface2 border border-border-light rounded-lg text-text placeholder:text-text-muted focus:outline-none focus:border-accent text-sm"
                />
                <Mail className="w-4 h-4 text-text-muted absolute left-3.5 top-3.5" />
              </div>
            </div>
            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider">
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => { setAuthMode("otp"); setMessage(null); }}
                  className="text-[10px] font-bold text-text hover:text-accent-hover transition-colors"
                >
                  Forgot Password?
                </button>
              </div>
              <div className="relative">
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-10 pr-4 py-3 bg-surface2 border border-border-light rounded-lg text-text placeholder:text-text-muted focus:outline-none focus:border-accent text-sm"
                />
                <Lock className="w-4 h-4 text-text-muted absolute left-3.5 top-3.5" />
              </div>
            </div>
            <button
              type="submit"
              disabled={isSending}
              className="w-full py-3 bg-accent hover:bg-accent-hover text-accent-contrast font-bold rounded-lg transition-colors text-sm flex items-center justify-center gap-1.5 shadow-sm"
            >
              {isSending ? "Signing In..." : "Sign In"}
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        )}

        {authMode === "otp" && (
          <form onSubmit={handleMagicLink} className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-2">
                Email Address
              </label>
              <div className="relative">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full pl-10 pr-4 py-3 bg-surface2 border border-border-light rounded-lg text-text placeholder:text-text-muted focus:outline-none focus:border-accent text-sm"
                />
                <Mail className="w-4 h-4 text-text-muted absolute left-3.5 top-3.5" />
              </div>
            </div>
            <button
              type="submit"
              disabled={isSending}
              className="w-full py-3 bg-accent hover:bg-accent-hover text-accent-contrast font-bold rounded-lg transition-colors text-sm flex items-center justify-center gap-1.5 shadow-sm"
            >
              {isSending ? "Sending Link..." : "Send Magic Link"}
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => { setAuthMode("login"); setMessage(null); }}
              className="w-full text-center text-xs text-text-secondary hover:text-text transition-colors mt-2"
            >
              Back to Password Sign In
            </button>
          </form>
        )}

        {authMode === "signup" && (
          <form onSubmit={handleSignup} className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-2">
                Email Address
              </label>
              <div className="relative">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full pl-10 pr-4 py-3 bg-surface2 border border-border-light rounded-lg text-text placeholder:text-text-muted focus:outline-none focus:border-accent text-sm"
                />
                <Mail className="w-4 h-4 text-text-muted absolute left-3.5 top-3.5" />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-2">
                Password
              </label>
              <div className="relative">
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  className="w-full pl-10 pr-4 py-3 bg-surface2 border border-border-light rounded-lg text-text placeholder:text-text-muted focus:outline-none focus:border-accent text-sm"
                />
                <Lock className="w-4 h-4 text-text-muted absolute left-3.5 top-3.5" />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-2">
                Confirm Password
              </label>
              <div className="relative">
                <input
                  type="password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  className="w-full pl-10 pr-4 py-3 bg-surface2 border border-border-light rounded-lg text-text placeholder:text-text-muted focus:outline-none focus:border-accent text-sm"
                />
                <Lock className="w-4 h-4 text-text-muted absolute left-3.5 top-3.5" />
              </div>
            </div>
            <button
              type="submit"
              disabled={isSending}
              className="w-full py-3 bg-accent hover:bg-accent-hover text-accent-contrast font-bold rounded-lg transition-colors text-sm flex items-center justify-center gap-1.5 shadow-sm"
            >
              {isSending ? "Creating Account..." : "Create Account"}
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        )}

        <div className="border-t border-border mt-6 pt-5 text-center">
          {authMode === "login" && (
            <p className="text-xs text-text-secondary">
              New to Omni?{" "}
              <button
                type="button"
                onClick={() => { setAuthMode("signup"); setMessage(null); }}
                className="font-bold text-text hover:text-accent-hover transition-colors"
              >
                Create an account
              </button>
            </p>
          )}

          {authMode === "signup" && (
            <p className="text-xs text-text-secondary">
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => { setAuthMode("login"); setMessage(null); }}
                className="font-bold text-text hover:text-accent-hover transition-colors"
              >
                Sign In
              </button>
            </p>
          )}

          {authMode === "otp" && (
            <p className="text-xs text-text-secondary">
              Don't have an account yet?{" "}
              <button
                type="button"
                onClick={() => { setAuthMode("signup"); setMessage(null); }}
                className="font-bold text-text hover:text-accent-hover transition-colors"
              >
                Sign Up
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
