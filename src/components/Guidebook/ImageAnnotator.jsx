import { useEffect, useRef, useState, useCallback } from 'react';
import { X, Circle, Square, Minus, ArrowRight, Type, PenLine, RotateCcw, Check } from 'lucide-react';
import styles from './ImageAnnotator.module.css';

const COLORS = ['#e53e3e', '#dd6b20', '#d69e2e', '#38a169', '#3182ce', '#805ad5', '#000000', '#ffffff'];
const STROKE_SIZES = [2, 4, 7, 12];
const TOOLS = [
    { id: 'pen',   icon: PenLine,    label: '펜' },
    { id: 'circle', icon: Circle,    label: '원' },
    { id: 'rect',   icon: Square,    label: '사각형' },
    { id: 'line',   icon: Minus,     label: '직선' },
    { id: 'arrow',  icon: ArrowRight, label: '화살표' },
    { id: 'text',   icon: Type,      label: '텍스트' },
];

// 컴포넌트 외부 순수 함수 — hook 의존성 문제 없음
function drawAnnotation(ctx, a) {
    ctx.save();
    ctx.strokeStyle = a.color;
    ctx.fillStyle   = a.color;
    ctx.lineWidth   = a.strokeW;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    switch (a.type) {
        case 'pen':
            if (a.path.length < 2) break;
            ctx.beginPath();
            ctx.moveTo(a.path[0].x, a.path[0].y);
            a.path.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
            ctx.stroke();
            break;
        case 'circle': {
            const rx = (a.x2 - a.x1) / 2;
            const ry = (a.y2 - a.y1) / 2;
            ctx.beginPath();
            ctx.ellipse(a.x1 + rx, a.y1 + ry, Math.abs(rx), Math.abs(ry), 0, 0, 2 * Math.PI);
            ctx.stroke();
            break;
        }
        case 'rect':
            ctx.strokeRect(a.x1, a.y1, a.x2 - a.x1, a.y2 - a.y1);
            break;
        case 'line':
            ctx.beginPath();
            ctx.moveTo(a.x1, a.y1);
            ctx.lineTo(a.x2, a.y2);
            ctx.stroke();
            break;
        case 'arrow': {
            const dx = a.x2 - a.x1;
            const dy = a.y2 - a.y1;
            const len = Math.hypot(dx, dy);
            if (len < 1) break;
            const ux = dx / len;
            const uy = dy / len;
            const hw = a.strokeW * 4;
            ctx.beginPath();
            ctx.moveTo(a.x1, a.y1);
            ctx.lineTo(a.x2, a.y2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(a.x2, a.y2);
            ctx.lineTo(a.x2 - ux * hw - uy * hw * 0.5, a.y2 - uy * hw + ux * hw * 0.5);
            ctx.lineTo(a.x2 - ux * hw + uy * hw * 0.5, a.y2 - uy * hw - ux * hw * 0.5);
            ctx.closePath();
            ctx.fill();
            break;
        }
        case 'text':
            ctx.font = `bold ${a.fontSize}px sans-serif`;
            ctx.fillText(a.text, a.x, a.y);
            break;
        default: break;
    }
    ctx.restore();
}

export default function ImageAnnotator({ src, onSave, onCancel }) {
    const canvasRef  = useRef(null);
    const imgRef     = useRef(null);
    const [tool, setTool]     = useState('circle');
    const [color, setColor]   = useState('#e53e3e');
    const [strokeW, setStrokeW] = useState(4);
    const [history, setHistory] = useState([]);  // 저장된 주석 목록
    const [drawing, setDrawing] = useState(false);
    const [start, setStart]   = useState({ x: 0, y: 0 });
    const [textInput, setTextInput] = useState(null); // { x, y, px, py } canvas좌표 + 화면좌표
    const [textVal, setTextVal] = useState('');
    const penPathRef = useRef([]);

    // ── 캔버스에 이미지 + 주석 전체 재렌더 ───────────────────────────────────
    const redraw = useCallback((annotations, tempAnnotation = null) => {
        const canvas = canvasRef.current;
        const img = imgRef.current;
        if (!canvas || !img) return;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        [...annotations, ...(tempAnnotation ? [tempAnnotation] : [])].forEach((a) => drawAnnotation(ctx, a));
    }, []);

    useEffect(() => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            imgRef.current = img;
            const canvas = canvasRef.current;
            if (!canvas) return;
            // 캔버스 크기를 이미지에 맞춤 (최대 900px)
            const maxW = 900;
            const scale = img.naturalWidth > maxW ? maxW / img.naturalWidth : 1;
            canvas.width  = Math.round(img.naturalWidth  * scale);
            canvas.height = Math.round(img.naturalHeight * scale);
            redraw([]);
        };
        img.src = src;
    }, [src, redraw]);

    useEffect(() => { redraw(history); }, [history, redraw]);

    // ── 좌표 변환 ─────────────────────────────────────────────────────────────
    const getPos = (e) => {
        const canvas = canvasRef.current;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width  / rect.width;
        const scaleY = canvas.height / rect.height;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
    };

    // ── 마우스/터치 이벤트 ────────────────────────────────────────────────────
    const onPointerDown = (e) => {
        if (tool === 'text') return;
        setDrawing(true);
        const pos = getPos(e);
        setStart(pos);
        if (tool === 'pen') penPathRef.current = [pos];
    };

    const onPointerMove = (e) => {
        if (!drawing) return;
        const pos = getPos(e);
        if (tool === 'pen') {
            penPathRef.current.push(pos);
            redraw(history, { type: 'pen', path: [...penPathRef.current], color, strokeW });
        } else {
            redraw(history, { type: tool, x1: start.x, y1: start.y, x2: pos.x, y2: pos.y, color, strokeW });
        }
    };

    const onPointerUp = (e) => {
        if (!drawing) return;
        setDrawing(false);
        const pos = getPos(e);
        let annotation;
        if (tool === 'pen') {
            annotation = { type: 'pen', path: [...penPathRef.current], color, strokeW };
        } else {
            annotation = { type: tool, x1: start.x, y1: start.y, x2: pos.x, y2: pos.y, color, strokeW };
        }
        setHistory((prev) => [...prev, annotation]);
    };

    const onCanvasClick = (e) => {
        if (tool !== 'text') return;
        const pos = getPos(e);
        const rect = canvasRef.current.getBoundingClientRect();
        // 화면 픽셀 좌표 = 캔버스 좌표 / 스케일
        const scale = canvasRef.current.width / rect.width;
        setTextInput({ x: pos.x, y: pos.y, px: pos.x / scale, py: pos.y / scale });
        setTextVal('');
    };

    const confirmText = () => {
        if (!textVal.trim() || !textInput) { setTextInput(null); return; }
        const fontSize = strokeW * 5 + 10;
        setHistory((prev) => [...prev, { type: 'text', x: textInput.x, y: textInput.y + fontSize, text: textVal, color, strokeW, fontSize }]);
        setTextInput(null);
        setTextVal('');
    };

    const undo = () => setHistory((prev) => prev.slice(0, -1));

    const save = () => {
        const canvas = canvasRef.current;
        onSave(canvas.toDataURL('image/png'));
    };

    return (
        <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
            <div className={styles.modal}>
                {/* 상단 툴바 */}
                <div className={styles.toolbar}>
                    <div className={styles.toolGroup}>
                        {TOOLS.map((t) => {
                            const TIcon = t.icon;
                            return (
                                <button key={t.id}
                                    className={`${styles.toolBtn} ${tool === t.id ? styles.active : ''}`}
                                    title={t.label}
                                    onClick={() => setTool(t.id)}>
                                    <TIcon size={17} />
                                </button>
                            );
                        })}
                    </div>

                    <div className={styles.toolDivider} />

                    <div className={styles.toolGroup}>
                        {COLORS.map((c) => (
                            <button key={c} className={`${styles.colorBtn} ${color === c ? styles.colorActive : ''}`}
                                style={{ background: c, borderColor: c === '#ffffff' ? '#ccc' : c }}
                                onClick={() => setColor(c)} />
                        ))}
                    </div>

                    <div className={styles.toolDivider} />

                    <div className={styles.toolGroup}>
                        {STROKE_SIZES.map((s) => (
                            <button key={s}
                                className={`${styles.strokeBtn} ${strokeW === s ? styles.active : ''}`}
                                onClick={() => setStrokeW(s)}>
                                <span className={styles.strokeDot} style={{ width: s * 2, height: s * 2 }} />
                            </button>
                        ))}
                    </div>

                    <div className={styles.toolDivider} />

                    <button className={styles.undoBtn} onClick={undo} disabled={history.length === 0} title="실행 취소">
                        <RotateCcw size={15} />
                    </button>

                    <div style={{ flex: 1 }} />

                    <button className={styles.saveBtn} onClick={save}>
                        <Check size={15} /> 적용
                    </button>
                    <button className={styles.cancelBtn} onClick={onCancel}>
                        <X size={15} />
                    </button>
                </div>

                {/* 캔버스 영역 */}
                <div className={styles.canvasWrap}>
                    <canvas
                        ref={canvasRef}
                        className={`${styles.canvas} ${styles[`cursor_${tool}`] || styles.cursor_default}`}
                        onMouseDown={onPointerDown}
                        onMouseMove={onPointerMove}
                        onMouseUp={onPointerUp}
                        onMouseLeave={() => { if (drawing) onPointerUp({ clientX: 0, clientY: 0 }); }}
                        onClick={onCanvasClick}
                    />
                    {/* 텍스트 입력 */}
                    {textInput && (
                        <div className={styles.textInputWrap}
                            style={{ left: textInput.px, top: textInput.py }}>
                            <input autoFocus className={styles.textInput}
                                style={{ color, fontSize: strokeW * 5 + 10 }}
                                value={textVal}
                                onChange={(e) => setTextVal(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') confirmText(); if (e.key === 'Escape') setTextInput(null); }}
                                onBlur={confirmText}
                                placeholder="텍스트 입력 후 Enter" />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
