# TikZJax Next — smoke test

Basic shape (should render in well under a second once the engine is warm):

```tikz
\begin{tikzpicture}
\draw (0,0) circle (1cm);
\draw (-1.5,0) -- (1.5,0);
\node at (0,-2) {ciao};
\end{tikzpicture}
```

Dark mode: this must be legible in BOTH themes, and switching theme must not
recompile anything (watch the console — no new engine activity).

```tikz
\begin{tikzpicture}
\fill[orange] (-2,-1) rectangle (2,1);
\fill[white] (0,0) circle (0.6cm);
\draw[black] (0,0) circle (0.6cm);
\end{tikzpicture}
```

Fonts. If the WOFF2 faces did not load, these come out in a fallback font and the
maths is subtly wrong rather than obviously broken:

```tikz
\begin{tikzpicture}
\node at (0,0) {$\Omega \otimes \Gamma \oplus \Delta \quad \frac{a+b}{c-d}$};
\end{tikzpicture}
```

pgfplots — the headline feature, and the slowest fixture (~1.2 s cold):

```tikz
\usepackage{pgfplots}
\pgfplotsset{compat=1.16}
\begin{document}
\begin{tikzpicture}
\begin{axis}[xlabel=$x$, ylabel=$y$, width=9cm, height=6cm]
\addplot[blue, domain=-3:3, samples=60] {x^2};
\addplot[red,  domain=-3:3, samples=60] {2*x};
\end{axis}
\end{tikzpicture}
\end{document}
```

A pgfplots LIBRARY. This is upstream #28/#79, unfixable in the old plugin:

```tikz
\usepackage{pgfplots}
\pgfplotsset{compat=1.16}
\usepgfplotslibrary{fillbetween}
\begin{document}
\begin{tikzpicture}
\begin{axis}[width=9cm, height=6cm]
\addplot[name path=A, domain=0:3, samples=40] {x};
\addplot[name path=B, domain=0:3, samples=40] {0.5*x^2};
\addplot[gray, opacity=0.4] fill between[of=A and B];
\end{axis}
\end{tikzpicture}
\end{document}
```

expl3, via xparse. If this renders, the ~37 issues the backlog calls permanently
impossible are back on the table:

```tikz
\usepackage{xparse}
\begin{document}
\NewDocumentCommand{\tikzjaxbox}{O{black} m}{\node[draw=#1] {#2};}
\begin{tikzpicture}
\tikzjaxbox[blue]{expl3 works}
\end{tikzpicture}
\end{document}
```

A DELIBERATELY BROKEN diagram. The old plugin shows a broken-image icon and wedges
every later diagram until you restart Obsidian. This should render what it can AND
name the problem with a line number:

```tikz
\begin{tikzpicture}
\draw (0,0) -- (1,1);
\undefinedcontrolsequence
\end{tikzpicture}
```

An empty block, which used to hang the session:

```tikz
```

Two copies of the same diagram. Their internal ids must not collide — if they do,
one of them loses its clipping (upstream #12):

```tikz
\begin{tikzpicture}
\clip (-1,-1) rectangle (1,1);
\fill[teal] (0,0) circle (1.4cm);
\end{tikzpicture}
```

```tikz
\begin{tikzpicture}
\clip (-1,-1) rectangle (1,1);
\fill[purple] (0,0) circle (1.4cm);
\end{tikzpicture}
```
