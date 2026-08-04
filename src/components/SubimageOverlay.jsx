export default function SubimageOverlay({ crop, imageWidth, imageHeight }) {
  if (!crop || !imageWidth || !imageHeight) return null;

  const inner = `M ${crop.x} ${crop.y} H ${crop.x + crop.width} V ${crop.y + crop.height} H ${crop.x} Z`;
  const outer = `M 0 0 H ${imageWidth} V ${imageHeight} H 0 Z`;

  return (
    <svg className="subimage-overlay" viewBox={`0 0 ${imageWidth} ${imageHeight}`} aria-label="Subimage crop overlay">
      <path data-testid="subimage-outside-shade" d={`${outer} ${inner}`} fillRule="evenodd" />
      <rect
        aria-label={`Crop x ${crop.x} y ${crop.y} width ${crop.width} height ${crop.height}`}
        className="subimage-crop-outline"
        x={crop.x}
        y={crop.y}
        width={crop.width}
        height={crop.height}
      />
    </svg>
  );
}
