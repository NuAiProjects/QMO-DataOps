import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type LoadingStateProps = {
  label?: string;
  className?: string;
};

function LoadingState({ label = "Loading...", className }: LoadingStateProps) {
  return (
    <div
      className={cn(
        "flex min-h-[280px] items-center justify-center gap-3 rounded-md border border-dashed bg-muted/20 text-muted-foreground",
        className,
      )}
    >
      <Spinner className="h-5 w-5" />
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}

function FullScreenLoader({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex items-center gap-3 rounded-md border bg-card px-4 py-3 text-muted-foreground shadow-sm">
        <Spinner className="h-5 w-5" />
        <span className="text-sm font-medium">{label}</span>
      </div>
    </div>
  );
}

export { LoadingState, FullScreenLoader };
