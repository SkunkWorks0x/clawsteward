export default function AgentLoading() {
  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-[#1E293B] p-6">
        <div className="h-4 w-24 animate-pulse rounded bg-white/5" />
        <div className="mt-4 h-8 w-48 animate-pulse rounded-lg bg-white/5" />
        <div className="mt-2 h-4 w-64 animate-pulse rounded bg-white/5" />
      </div>
      <div className="rounded-xl bg-[#1E293B] p-6">
        <div className="mx-auto h-[140px] w-[140px] animate-pulse rounded-full bg-white/5" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl bg-[#1E293B] p-4">
            <div className="h-3 w-20 animate-pulse rounded bg-white/5" />
            <div className="mt-2 h-8 w-16 animate-pulse rounded-lg bg-white/5" />
          </div>
        ))}
      </div>
      <div className="rounded-xl bg-[#1E293B] p-6">
        <div className="h-6 w-32 animate-pulse rounded bg-white/5" />
        <div className="mt-4 h-48 animate-pulse rounded-lg bg-white/5" />
      </div>
    </div>
  );
}
