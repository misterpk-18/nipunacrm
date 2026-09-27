import { PageHead, Empty } from "./ui";

/** Temporary screen for routes whose module is not built yet. */
export function Placeholder({ title }: { title: string }) {
  return (
    <>
      <PageHead title={title} />
      <Empty title="This screen is being connected to the API" />
    </>
  );
}
