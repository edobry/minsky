import { KeyRound } from "lucide-react";
import { CredentialsManager } from "../widgets/Credentials";

export function SettingsPage() {
  return (
    <div className="p-4 flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Manage credentials and configuration.
        </p>
      </div>

      <section aria-label="Credentials">
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <KeyRound aria-hidden className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Credentials</h2>
          </div>
          <CredentialsManager />
        </div>
      </section>
    </div>
  );
}
