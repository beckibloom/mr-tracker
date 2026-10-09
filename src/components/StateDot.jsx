const StateDot = ({ card }) =>
  card.state === 'merged' ? (
    <span className="state-merged" title="Merged" aria-label="Merged">
      ✓
    </span>
  ) : (
    <span
      className={`pipeline-dot pipeline-dot--${card.pipeline.color}`}
      title={`Pipeline: ${card.pipeline.status}`}
    />
  );

export default StateDot;
