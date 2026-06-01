import { useEffect, useRef, useState, type RefObject } from "react";
import {
  FilesetResolver,
  FaceDetector,
  type Detection,
} from "@mediapipe/tasks-vision";

/**
 * useFaceTracker - runs MediaPipe FaceDetector against a live <img> (or
 * <video>) element on a fixed interval, and surfaces both the current
 * detections and a "continuously present for >= 5s" signal that the camera
 * can use to auto-trigger vision-1.
 *
 * Detector is hosted via JSDelivr CDN for wasm + Google's CDN for the model;
 * first init takes ~1-2s (~5MB download). After that, detection is cheap on
 * Strix Halo with GPU delegate.
 *
 * Presence semantics (lossy):
 *   - detections[i] for current frame; we only care about count > 0
 *   - `firstSeenTs` set when we go 0->1+ faces
 *   - `lastSeenTs` set every frame with at least one face
 *   - if (now - lastSeenTs > PRESENCE_GAP_RESET) → firstSeenTs = null
 *     (brief blips between frames don't reset the timer)
 *   - `presenceMs = now - firstSeenTs` (capped to MAX_PRESENCE so it doesn't
 *     grow unbounded if someone stands still for an hour)
 */

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

const SAMPLE_INTERVAL_MS = 100;     // 10 fps
const PRESENCE_GAP_RESET = 1000;    // 1s of no face -> reset firstSeenTs
const MAX_PRESENCE = 60_000;        // cap at 60s to keep numbers sane

export type FaceBox = {
  /** Normalised 0..1 against the source image's natural size. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Confidence 0..1 if the model reports one (else undefined). */
  score?: number;
};

export type FaceTrackerState = {
  /** Current detections, normalised to source-image coordinates (0..1). */
  faces: FaceBox[];
  /** True while detector init is in flight (model download / wasm load). */
  loading: boolean;
  /** Error from init or runtime. UI may render or ignore. */
  error: string | null;
  /** How long the latest run of "at least one face" has been ongoing, in ms.
   *  Resets to 0 when no face is seen for PRESENCE_GAP_RESET. */
  presenceMs: number;
};

function detectionToBox(
  d: Detection,
  imgWidth: number,
  imgHeight: number,
): FaceBox | null {
  const bb = d.boundingBox;
  if (!bb || imgWidth === 0 || imgHeight === 0) return null;
  return {
    x: bb.originX / imgWidth,
    y: bb.originY / imgHeight,
    w: bb.width / imgWidth,
    h: bb.height / imgHeight,
    score: d.categories?.[0]?.score,
  };
}

export function useFaceTracker(
  imgRef: RefObject<HTMLImageElement | null>,
  enabled: boolean,
): FaceTrackerState {
  const [faces, setFaces] = useState<FaceBox[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [presenceMs, setPresenceMs] = useState(0);

  const detectorRef = useRef<FaceDetector | null>(null);
  const firstSeenRef = useRef<number | null>(null);
  const lastSeenRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) {
      // Caller toggled off - clear detections, stop timer.
      setFaces([]);
      setPresenceMs(0);
      firstSeenRef.current = null;
      lastSeenRef.current = 0;
      return;
    }

    let cancelled = false;
    let interval: number | undefined;

    (async () => {
      try {
        if (!detectorRef.current) {
          setLoading(true);
          const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
          const detector = await FaceDetector.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: MODEL_URL,
              delegate: "GPU",
            },
            runningMode: "IMAGE",
            minDetectionConfidence: 0.5,
          });
          if (cancelled) {
            detector.close();
            return;
          }
          detectorRef.current = detector;
          setLoading(false);
        }

        const detector = detectorRef.current;
        interval = window.setInterval(() => {
          const img = imgRef.current;
          if (!img || img.naturalWidth === 0 || img.naturalHeight === 0) return;
          try {
            const result = detector.detect(img);
            const now = Date.now();
            const boxes = (result.detections ?? [])
              .map((d) => detectionToBox(d, img.naturalWidth, img.naturalHeight))
              .filter((b): b is FaceBox => b !== null);

            setFaces(boxes);

            // Presence bookkeeping.
            if (boxes.length > 0) {
              lastSeenRef.current = now;
              if (firstSeenRef.current === null) {
                firstSeenRef.current = now;
              }
            } else if (
              firstSeenRef.current !== null &&
              now - lastSeenRef.current > PRESENCE_GAP_RESET
            ) {
              firstSeenRef.current = null;
            }

            const presence =
              firstSeenRef.current === null
                ? 0
                : Math.min(MAX_PRESENCE, now - firstSeenRef.current);
            setPresenceMs(presence);
          } catch (e) {
            // Detection can sporadically fail mid-stream (cross-origin, image
            // half-loaded between MJPEG parts). Don't kill the loop.
            void e;
          }
        }, SAMPLE_INTERVAL_MS);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (interval !== undefined) window.clearInterval(interval);
      // Keep detectorRef alive across toggle/remount cycles - re-init is
      // expensive. It's released when the component finally unmounts via
      // the second effect below.
    };
  }, [imgRef, enabled]);

  // Final detector cleanup on full unmount.
  useEffect(() => {
    return () => {
      detectorRef.current?.close();
      detectorRef.current = null;
    };
  }, []);

  return { faces, loading, error, presenceMs };
}
