import { useTranslation } from 'react-i18next';
import type { ResizableSidebar } from '../hooks/useResizableSidebar';

export function SidebarResizeHandle({ sidebar }: { sidebar: ResizableSidebar }) {
  const { t } = useTranslation();
  return (
    <div
      className="gf-sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('app.sidebar.resizeLabel')}
      aria-valuenow={sidebar.width}
      aria-valuemin={sidebar.min}
      aria-valuemax={sidebar.max}
      tabIndex={0}
      onMouseDown={sidebar.onHandleMouseDown}
      onKeyDown={sidebar.onHandleKeyDown}
      onDoubleClick={sidebar.onHandleDoubleClick}
    />
  );
}
