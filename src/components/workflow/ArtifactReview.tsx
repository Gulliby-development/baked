export function ArtifactReview({ title, content }: { title: string; content: string }) {
  return (
    <box flexDirection="column">
      <text attributes={1}>{title}</text>
      <text>{content}</text>
    </box>
  );
}
