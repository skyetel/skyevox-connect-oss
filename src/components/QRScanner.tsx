import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '../hooks/useFocusTrap';
import jsQR from 'jsqr';

interface Props {
  onScan: (data: string) => void;
  onClose: () => void;
}

export function QRScanner({ onScan, onClose }: Props) {
  const { t } = useTranslation();
  const trapRef = useFocusTrap<HTMLDivElement>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const scanRef = useRef<() => void>(() => {});
  const [error, setError] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
  }, []);

  const scan = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
      animFrameRef.current = requestAnimationFrame(() => scanRef.current());
      return;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);

    if (code?.data) {
      stopCamera();
      onScan(code.data);
      return;
    }

    animFrameRef.current = requestAnimationFrame(() => scanRef.current());
  }, [onScan, stopCamera]);

  useEffect(() => {
    scanRef.current = scan;
  }, [scan]);

  useEffect(() => {
    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
          animFrameRef.current = requestAnimationFrame(() => scanRef.current());
        }
      } catch {
        setError(t('qrscanner.cameraError'));
      }
    }

    startCamera();
    return stopCamera;
  }, [scan, stopCamera, t]);

  return (
    <div ref={trapRef} className="fixed inset-0 bg-black z-50 flex flex-col" role="dialog" aria-modal="true" aria-label={t('qrscanner.title')}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/80">
        <span className="text-white font-medium text-sm">{t('qrscanner.title')}</span>
        <button
          onClick={() => {
            stopCamera();
            onClose();
          }}
          className="text-white text-2xl leading-none"
          aria-label={t('qrscanner.close')}
        >
          &times;
        </button>
      </div>

      {/* Camera view */}
      <div className="flex-1 relative overflow-hidden">
        {error ? (
          <div className="flex items-center justify-center h-full p-6">
            <div className="text-white text-center text-sm" role="alert">{error}</div>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              className="absolute inset-0 w-full h-full object-cover"
              playsInline
              muted
            />
            <canvas ref={canvasRef} className="hidden" />
            {/* Scan overlay */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-56 h-56 border-2 border-white/60 rounded-2xl relative">
                {/* Corner brackets */}
                <div className="absolute -top-0.5 -left-0.5 w-6 h-6 border-t-3 border-l-3 border-white rounded-tl-lg" />
                <div className="absolute -top-0.5 -right-0.5 w-6 h-6 border-t-3 border-r-3 border-white rounded-tr-lg" />
                <div className="absolute -bottom-0.5 -left-0.5 w-6 h-6 border-b-3 border-l-3 border-white rounded-bl-lg" />
                <div className="absolute -bottom-0.5 -right-0.5 w-6 h-6 border-b-3 border-r-3 border-white rounded-br-lg" />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Instructions */}
      <div className="px-4 py-3 bg-black/80">
        <p className="text-white/70 text-xs text-center">
          {t('qrscanner.instructions')}
        </p>
      </div>
    </div>
  );
}
