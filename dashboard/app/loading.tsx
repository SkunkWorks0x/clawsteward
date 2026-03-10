export default function Loading() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-48 animate-pulse rounded-lg bg-[#1E293B]" />
      <div className="h-4 w-64 animate-pulse rounded bg-[#1E293B]" />
      <div className="mt-6 rounded-xl bg-[#1E293B] p-6">
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-white/5" />
          ))}
        </div>
      </div>
    </div>
  );
}
