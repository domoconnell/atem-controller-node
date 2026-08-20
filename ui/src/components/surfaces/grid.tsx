'use client'
import { Responsive, WidthProvider } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'

const Grid = WidthProvider(Responsive)

export default function SurfaceGrid(props: { children?: React.ReactNode } & Record<string, unknown>) {
  return <Grid {...props} />
}
