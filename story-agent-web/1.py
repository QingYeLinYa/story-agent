def ss(arr):
    flag=False
    n=len(arr)
    for i in range(n-1):
        for j in range(n-i-1):
            if arr[j]>arr[j+1]:
                arr[j],arr[j+1]=arr[j+1],arr[j]
                flag=True
            if not flag:
                break
    return arr
def xx(arr):
    if len(arr)<=1:
        return arr
    mid=arr[len(arr)//2]
    left=[x for x in arr if x<mid]
    middle=[x for x in arr if x==mid]
    right=[x for x in arr if x>mid]
    return xx(left)+middle+xx(right)
print(xx([1,3,2,4,5,6,7,8,9,10]))
if __name__=="__main__":
    text=[1,3,2,4,5,6,7,8,9,10]
    ss(text)
