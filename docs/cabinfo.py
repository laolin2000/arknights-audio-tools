# 读取方舟 CAB 节点(Unity 序列化文件)中的 AudioClip 元数据
# 用法: python cabinfo.py <cab文件>
import sys
import UnityPy

def main(path):
    env = UnityPy.load(path)
    for obj in env.objects:
        try:
            cls = str(obj.type.name)
            d = obj.read()
            if cls == 'AudioClip':
                res = getattr(d, 'm_Resource', None)
                off = getattr(res, 'm_Offset', None) if res else None
                sz = getattr(res, 'm_Size', None) if res else None
                src = getattr(res, 'm_Source', None) if res else None
                print(f'AudioClip name={d.m_Name!r} loadType={d.m_LoadType} resOffset={off} resSize={sz} len={getattr(d, "m_Length", None)}')
                if src: print(f'  resourceSource={src!r}')
            else:
                print(f'{cls} name={getattr(d, "m_Name", None)!r}')
        except Exception as e:
            print(f'ERR obj path_id={obj.path_id}: {e}')

if __name__ == '__main__':
    main(sys.argv[1])
