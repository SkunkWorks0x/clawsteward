export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div className="rounded-xl bg-[#1E293B] p-12 text-center">
      <h1 className="text-xl font-bold text-white">Agent Detail</h1>
      <p className="mt-2 font-mono text-sm text-[#94A3B8]">{id}</p>
      <p className="mt-4 text-[#6B7280]">
        Full agent detail page coming soon (Day 16).
      </p>
    </div>
  );
}
